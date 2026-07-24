import { describe, expect, it } from "vite-plus/test";
import { AggregateRoot } from "../aggregate/aggregate-root";
import type { AnyDomainEvent, DomainEvent } from "../aggregate/domain-event";
import {
	ConcurrencyConflictError,
	EventHarvestError,
	IdempotencyCompletionWithoutClaimError,
	IdempotencyInFlightError,
	IdempotencyKeyReuseError,
} from "../core/errors";
import type { Id } from "../core/id";
import { InMemoryOutbox } from "../events/outbox";
import type { EventCommitCandidate } from "../events/ports";
import { RetryingTransactionScope } from "../repo/retrying-scope";
import type { TransactionScope } from "../repo/scope";
import type {
	AggregateCommitToken,
	CommitEnrollment,
	WithCommitWorkResult,
} from "./handler";
import type { IdempotencyClaimHandle } from "./idempotency";
import { withIdempotentCommit } from "./idempotency";
import { InMemoryIdempotencyStore } from "./in-memory-idempotency-store";

type OrderId = Id<"OrderId">;
type OrderEvent = DomainEvent<"OrderConfirmed", { orderId: string }>;
type OrderState = { status: "open" | "confirmed" };

class Order extends AggregateRoot<OrderState, OrderId, OrderEvent> {
	protected readonly aggregateType = "Order";

	constructor(id: OrderId) {
		super(id, { status: "open" });
	}

	confirm(): void {
		this.commit(
			{ ...this.state, status: "confirmed" },
			this.recordEventFromFactory("OrderConfirmed", { orderId: this.id }),
		);
	}
}

function createScope(): TransactionScope<undefined> {
	return {
		transactional: <T>(fn: (_ctx: undefined) => Promise<T>) => fn(undefined),
	};
}

function createDeps() {
	return {
		outbox: new InMemoryOutbox<AnyDomainEvent>(),
		scope: createScope(),
		idempotency: new InMemoryIdempotencyStore<undefined>(),
	};
}

const request = { key: "req-1", fingerprint: "fp-1" };

async function claimHandle(
	store: InMemoryIdempotencyStore<undefined>,
	key: string,
	fingerprint: string,
): Promise<IdempotencyClaimHandle> {
	const claim = await store.claim(undefined, key, fingerprint);
	if (claim.status !== "claimed") {
		throw new Error(`Expected a fresh claim, received ${claim.status}`);
	}
	return claim.claim;
}

describe("withIdempotentCommit", () => {
	it("rejects a legacy naked aggregate result and releases the claim", async () => {
		const deps = createDeps();
		const order = new Order("o-legacy" as OrderId);
		order.confirm();

		await expect(
			withIdempotentCommit(
				deps,
				request,
				async () =>
					({
						result: "must not commit",
						aggregates: [order],
					}) as unknown as WithCommitWorkResult<AnyDomainEvent, string>,
			),
		).rejects.toBeInstanceOf(EventHarvestError);
		expect(order.pendingEvents).toHaveLength(1);
		expect(await deps.outbox.getPending()).toEqual([]);

		await expect(
			withIdempotentCommit(deps, request, async () => ({
				result: "retry",
				commits: [],
			})),
		).resolves.toEqual({ replayed: false, result: "retry" });
	});

	it("seals the user enrollment capability before idempotency completion", async () => {
		const deps = createDeps();
		const originalComplete = deps.idempotency.complete.bind(deps.idempotency);
		let signalCompleteStarted: () => void = () => {};
		const completeStarted = new Promise<void>((resolve) => {
			signalCompleteStarted = resolve;
		});
		let releaseComplete: () => void = () => {};
		const completeBlocked = new Promise<void>((resolve) => {
			releaseComplete = resolve;
		});
		deps.idempotency.complete = async (ctx, key, outcome) => {
			await originalComplete(ctx, key, outcome);
			signalCompleteStarted();
			await completeBlocked;
		};

		let leaked: CommitEnrollment<AnyDomainEvent> | undefined;
		const execution = withIdempotentCommit(
			deps,
			request,
			async (_ctx, enrollment) => {
				leaked = enrollment;
				return { result: "ok", commits: [] };
			},
		);
		await completeStarted;

		expect(() => leaked?.enrollSaved(new Order("o-late" as OrderId))).toThrow(
			EventHarvestError,
		);
		releaseComplete();
		await expect(execution).resolves.toEqual({ replayed: false, result: "ok" });
	});

	it("snapshots commit tokens before idempotency completion can yield", async () => {
		const deps = createDeps();
		const originalComplete = deps.idempotency.complete.bind(deps.idempotency);
		let signalCompleteStarted: () => void = () => {};
		const completeStarted = new Promise<void>((resolve) => {
			signalCompleteStarted = resolve;
		});
		let releaseComplete: () => void = () => {};
		const completeBlocked = new Promise<void>((resolve) => {
			releaseComplete = resolve;
		});
		deps.idempotency.complete = async (ctx, key, outcome) => {
			await originalComplete(ctx, key, outcome);
			signalCompleteStarted();
			await completeBlocked;
		};

		const order = new Order("o-snapshot" as OrderId);
		order.confirm();
		let mutableCommits: AggregateCommitToken<AnyDomainEvent>[] = [];
		const execution = withIdempotentCommit(
			deps,
			request,
			async (_ctx, enrollment) => {
				mutableCommits = [enrollment.enrollSaved(order)];
				return { result: order.id, commits: mutableCommits };
			},
		);
		await completeStarted;
		mutableCommits.length = 0;
		releaseComplete();

		await expect(execution).resolves.toEqual({
			replayed: false,
			result: "o-snapshot",
		});
		expect(order.pendingEvents).toHaveLength(0);
		expect(await deps.outbox.getPending()).toHaveLength(1);
	});

	it("runs the work fresh, stores the outcome, and harvests events", async () => {
		const deps = createDeps();
		const order = new Order("o-1" as OrderId);

		const outcome = await withIdempotentCommit(
			deps,
			request,
			async (_ctx, enrollment) => {
				order.confirm();
				return {
					result: { orderId: order.id },
					commits: [enrollment.enrollSaved(order)],
				};
			},
		);

		expect(outcome).toEqual({ replayed: false, result: { orderId: "o-1" } });
		expect(order.pendingEvents).toHaveLength(0); // acknowledgement ran
		const pending = await deps.outbox.getPending();
		expect(pending).toHaveLength(1);
		expect(pending[0]?.event.type).toBe("OrderConfirmed");
	});

	it("replays the stored outcome on a duplicate without re-running the work", async () => {
		const deps = createDeps();
		let executions = 0;
		const work = async (
			_ctx: undefined,
			enrollment: CommitEnrollment<AnyDomainEvent>,
		) => {
			executions++;
			const order = new Order("o-1" as OrderId);
			order.confirm();
			return {
				result: { orderId: order.id },
				commits: [enrollment.enrollSaved(order)],
			};
		};

		await withIdempotentCommit(deps, request, work);
		const replayed = await withIdempotentCommit(deps, request, work);

		expect(executions).toBe(1);
		expect(replayed).toEqual({ replayed: true, result: { orderId: "o-1" } });
		// No second harvest: the duplicate emitted no events.
		expect(await deps.outbox.getPending()).toHaveLength(1);
	});

	it("rejects the same key with a different fingerprint", async () => {
		const deps = createDeps();
		await withIdempotentCommit(deps, request, async () => ({
			result: "first",
			commits: [],
		}));

		await expect(
			withIdempotentCommit(
				deps,
				{ key: request.key, fingerprint: "fp-OTHER" },
				async () => ({ result: "second", commits: [] }),
			),
		).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
	});

	it("surfaces a concurrent in-flight duplicate as a retryable error", async () => {
		const deps = createDeps();
		let releaseFirst: () => void = () => {};
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = withIdempotentCommit(deps, request, async () => {
			await firstBlocked;
			return { result: "first", commits: [] };
		});
		// Give the first execution time to claim.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const second = withIdempotentCommit(deps, request, async () => ({
			result: "second",
			commits: [],
		}));
		await expect(second).rejects.toBeInstanceOf(IdempotencyInFlightError);
		await expect(second).rejects.toMatchObject({ retryable: true });

		releaseFirst();
		await expect(first).resolves.toEqual({
			replayed: false,
			result: "first",
		});
	});

	it("composes with RetryingTransactionScope: a retryable attempt failure releases its claim and the retry runs fresh", async () => {
		const inner = createScope();
		const deps = {
			outbox: new InMemoryOutbox<AnyDomainEvent>(),
			scope: new RetryingTransactionScope(inner, {
				maxAttempts: 3,
				baseDelayMs: 1,
			}),
			idempotency: new InMemoryIdempotencyStore<undefined>(),
		};
		let executions = 0;

		const outcome = await withIdempotentCommit(deps, request, async () => {
			executions++;
			if (executions === 1) {
				throw new ConcurrencyConflictError({
					aggregateType: "Order",
					aggregateId: "o-1",
					expectedVersion: 1,
					actualVersion: 2,
				});
			}
			return { result: "second attempt", commits: [] };
		});

		expect(executions).toBe(2);
		expect(outcome).toEqual({ replayed: false, result: "second attempt" });
	});

	it("does not replay a false success when the transaction fails after complete()", async () => {
		class FlakyOutbox extends InMemoryOutbox<AnyDomainEvent> {
			failNext = true;
			override async add(
				events: ReadonlyArray<EventCommitCandidate<AnyDomainEvent>>,
			): Promise<void> {
				if (this.failNext) {
					this.failNext = false;
					throw new Error("outbox down");
				}
				return super.add(events);
			}
		}
		const deps = {
			outbox: new FlakyOutbox(),
			scope: createScope(),
			idempotency: new InMemoryIdempotencyStore<undefined>(),
		};
		let executions = 0;
		const work = async (
			_ctx: undefined,
			enrollment: CommitEnrollment<AnyDomainEvent>,
		) => {
			executions++;
			const order = new Order(`o-${executions}` as OrderId);
			order.confirm();
			return {
				result: { orderId: order.id },
				commits: [enrollment.enrollSaved(order)],
			};
		};

		// First call: complete() runs, then the outbox write fails inside
		// the transaction. The staged outcome must not become replayable.
		await expect(withIdempotentCommit(deps, request, work)).rejects.toThrow(
			"outbox down",
		);

		const second = await withIdempotentCommit(deps, request, work);
		expect(executions).toBe(2);
		expect(second).toEqual({ replayed: false, result: { orderId: "o-2" } });

		// Only the committed outcome replays afterwards.
		const third = await withIdempotentCommit(deps, request, work);
		expect(executions).toBe(2);
		expect(third).toEqual({ replayed: true, result: { orderId: "o-2" } });
	});

	it("releases the claim when the work fails, so a retry runs fresh", async () => {
		const deps = createDeps();
		await expect(
			withIdempotentCommit(deps, request, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		const retried = await withIdempotentCommit(deps, request, async () => ({
			result: "second attempt",
			commits: [],
		}));
		expect(retried).toEqual({ replayed: false, result: "second attempt" });
	});

	it("propagates the work error even when abandon itself fails", async () => {
		const deps = createDeps();
		deps.idempotency.abandon = async () => {
			throw new Error("abandon failed");
		};
		await expect(
			withIdempotentCommit(deps, request, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
	});

	it("does not abandon when the claim itself was the failure", async () => {
		const deps = createDeps();
		await withIdempotentCommit(deps, request, async () => ({
			result: "first",
			commits: [],
		}));
		let abandoned = false;
		const originalAbandon = deps.idempotency.abandon.bind(deps.idempotency);
		deps.idempotency.abandon = async (claim: IdempotencyClaimHandle) => {
			abandoned = true;
			return originalAbandon(claim);
		};

		await expect(
			withIdempotentCommit(
				deps,
				{ key: request.key, fingerprint: "fp-OTHER" },
				async () => ({ result: "x", commits: [] }),
			),
		).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
		expect(abandoned).toBe(false);
	});
});

describe("InMemoryIdempotencyStore", () => {
	it("isolates stored outcomes from caller mutation", async () => {
		const store = new InMemoryIdempotencyStore<undefined>();
		const handle = await claimHandle(store, "k", "fp");
		const outcome = { items: ["a"] };
		await store.complete(undefined, handle, outcome);
		await store.confirm(handle);
		outcome.items.push("b"); // caller mutates after storing

		const claim = await store.claim(undefined, "k", "fp");
		expect(claim).toEqual({
			status: "completed",
			outcome: { items: ["a"] },
		});
		if (claim.status === "completed") {
			(claim.outcome as { items: string[] }).items.push("c");
		}
		const again = await store.claim(undefined, "k", "fp");
		expect(again).toEqual({ status: "completed", outcome: { items: ["a"] } });
	});

	it("throws the wiring error on complete without a claim", async () => {
		const store = new InMemoryIdempotencyStore<undefined>();
		await expect(
			store.complete(undefined, { key: "k", token: "missing" }, "x"),
		).rejects.toBeInstanceOf(IdempotencyCompletionWithoutClaimError);
	});

	it("a staged, unconfirmed outcome is in-flight, never replayed", async () => {
		const store = new InMemoryIdempotencyStore<undefined>();
		const handle = await claimHandle(store, "k", "fp");
		await store.complete(undefined, handle, "uncommitted");
		await expect(store.claim(undefined, "k", "fp")).rejects.toBeInstanceOf(
			IdempotencyInFlightError,
		);
	});

	it("abandon releases pending and staged entries, never confirmed records", async () => {
		const store = new InMemoryIdempotencyStore<undefined>();
		const staged = await claimHandle(store, "staged", "fp");
		await store.complete(undefined, staged, "uncommitted");
		await store.abandon(staged);
		await expect(store.claim(undefined, "staged", "fp")).resolves.toMatchObject(
			{
				status: "claimed",
			},
		);

		const confirmed = await claimHandle(store, "confirmed", "fp");
		await store.complete(undefined, confirmed, "done");
		await store.confirm(confirmed);
		await store.abandon(confirmed);
		const claim = await store.claim(undefined, "confirmed", "fp");
		expect(claim).toEqual({ status: "completed", outcome: "done" });
	});

	it("rejects a new key at capacity while preserving replay of existing keys", async () => {
		const store = new InMemoryIdempotencyStore<undefined>({ maxEntries: 1 });
		const existing = await claimHandle(store, "existing", "fp");
		await store.complete(undefined, existing, { orderId: "o-1" });
		await store.confirm(existing);

		await expect(store.claim(undefined, "new", "fp-new")).rejects.toMatchObject(
			{
				code: "IN_MEMORY_CAPACITY_EXCEEDED",
				store: "InMemoryIdempotencyStore",
				resource: "entries",
				limit: 1,
				current: 1,
				attempted: 1,
			},
		);
		await expect(store.claim(undefined, "existing", "fp")).resolves.toEqual({
			status: "completed",
			outcome: { orderId: "o-1" },
		});
		expect(store.size).toBe(1);
	});

	it("releases capacity when an unconfirmed claim is abandoned", async () => {
		const store = new InMemoryIdempotencyStore<undefined>({ maxEntries: 1 });
		const first = await claimHandle(store, "first", "fp-1");
		await store.abandon(first);

		await expect(
			store.claim(undefined, "second", "fp-2"),
		).resolves.toMatchObject({ status: "claimed" });
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid maxEntries capacity %s",
		(maxEntries) => {
			expect(() => new InMemoryIdempotencyStore({ maxEntries })).toThrowError(
				RangeError,
			);
		},
	);
});
