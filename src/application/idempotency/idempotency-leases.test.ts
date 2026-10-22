import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { StateStoredAggregate } from "../../domain/aggregate/state-stored-aggregate";
import {
	type AnyDomainEvent,
	createDomainEvent,
	type DomainEvent,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	ConcurrencyConflictError,
	IdempotencyInFlightError,
	IdempotencyKeyReuseError,
} from "../../errors/kit-errors";
import type { EventCommitCandidate } from "../../messaging/committed-event";
import { InMemoryOutbox } from "../../messaging/outbox/outbox";
import { RetryingTransactionScope } from "../../persistence/repository/retrying-scope";
import type { TransactionScope } from "../../persistence/repository/scope";
import type { CommitRegistration } from "../cqrs/handler";
import { InMemoryLeasedIdempotencyStore } from "./adapters/in-memory-leased-idempotency-store";
import {
	type IdempotencyReconciliation,
	type LeasedIdempotencyClaim,
	type LeasedIdempotencyClaimHandle,
	withIdempotentCommit,
} from "./idempotency";

type OrderId = Id<"OrderId">;
type OrderEvent = DomainEvent<"OrderConfirmed", { orderId: string }>;

class Order extends StateStoredAggregate<
	{ status: "open" | "confirmed" },
	OrderId,
	OrderEvent
> {
	protected readonly aggregateType = "Order";

	constructor(id: OrderId) {
		super(id, { status: "open" });
	}

	confirm(): void {
		this.setState(
			{ status: "confirmed" },
			createDomainEvent(
				"OrderConfirmed",
				{ orderId: this.id },
				{ aggregateId: this.id, aggregateType: this.aggregateType },
			),
		);
	}
}

interface MutableClock {
	advance(ms: number): void;
	now(): Date;
}

function mutableClock(initial = "2026-07-14T10:00:00.000Z"): MutableClock {
	let now = new Date(initial).getTime();
	return {
		advance: (ms) => {
			now += ms;
		},
		now: () => new Date(now),
	};
}

function tokenFactory(): () => string {
	let next = 0;
	return () => `claim-${++next}`;
}

function leasedStore(clock: MutableClock) {
	return new InMemoryLeasedIdempotencyStore<undefined>({
		clock: clock.now,
		claimTokenFactory: tokenFactory(),
		leaseDurationMs: 100,
		renewAfterMs: 40,
	});
}

function claimedHandle(
	claim: LeasedIdempotencyClaim,
): LeasedIdempotencyClaimHandle {
	if (claim.status !== "claimed") {
		throw new Error(`Expected claimed, received ${claim.status}`);
	}
	return claim.claim;
}

function scope(): TransactionScope<undefined> {
	return {
		transactional: <T>(work: (ctx: undefined) => Promise<T>) => work(undefined),
	};
}

function createDeps(
	idempotency = new InMemoryLeasedIdempotencyStore<undefined>(),
	outbox = new InMemoryOutbox<AnyDomainEvent>(),
) {
	return {
		outbox,
		scope: scope(),
		idempotency,
		reconcileIdempotency: async () => "unknown" as const,
	};
}

const request = { key: "req-1", fingerprint: "fp-1" };

afterEach(() => {
	vi.useRealTimers();
});

describe("withIdempotentCommit with a leased store", () => {
	it("requires reconcileIdempotency by type", () => {
		const { reconcileIdempotency: _required, ...withoutReconcile } =
			createDeps();

		// @ts-expect-error A leased store needs a reconciliation decision.
		void withIdempotentCommit(withoutReconcile, request, async () => "x");
	});

	it("releases the claim through abandon when the work fails, so a retry runs fresh", async () => {
		const deps = createDeps();
		await expect(
			withIdempotentCommit(deps, request, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		await expect(
			withIdempotentCommit(deps, request, async () => "second attempt"),
		).resolves.toEqual({ replayed: false, result: "second attempt" });
	});

	it("keeps the staged outcome when the commit itself fails, so a retry cannot run the command again", async () => {
		let nowMs = 0;
		const deps = {
			...createDeps(
				new InMemoryLeasedIdempotencyStore<undefined>({
					clock: () => new Date(nowMs),
					leaseDurationMs: 1_000,
				}),
			),
			reconcileIdempotency: async () => "committed" as const,
		};
		// A driver that rejects AFTER the callback resolved, for example a
		// dropped connection after COMMIT was sent: the commit outcome is
		// unknown, and the command effect can exist.
		let commits = 0;
		deps.scope = {
			transactional: async (fn) => {
				const result = await fn(undefined);
				commits += 1;
				if (commits === 1) throw new Error("commit failed");
				return result;
			},
		};
		let executions = 0;
		const run = () =>
			withIdempotentCommit(deps, request, async () => {
				executions += 1;
				return executions;
			});

		await expect(run()).rejects.toThrow("commit failed");
		await expect(run()).rejects.toBeInstanceOf(IdempotencyInFlightError);
		nowMs = 1_000;
		const settled = await run();

		expect(settled).toEqual({ replayed: true, result: 1 });
		expect(executions).toBe(1);
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
		const deps = createDeps(undefined, new FlakyOutbox());
		let executions = 0;
		const work = async (
			_ctx: undefined,
			registration: CommitRegistration<AnyDomainEvent>,
		) => {
			executions++;
			const order = new Order(`o-${executions}` as OrderId);
			order.confirm();
			registration.registerSaved(order);
			return { orderId: order.id };
		};

		// complete() stages the outcome, then the outbox write fails inside the
		// transaction. The staged outcome must not become replayable.
		await expect(withIdempotentCommit(deps, request, work)).rejects.toThrow(
			"outbox down",
		);

		const second = await withIdempotentCommit(deps, request, work);
		expect(executions).toBe(2);
		expect(second).toEqual({ replayed: false, result: { orderId: "o-2" } });

		const third = await withIdempotentCommit(deps, request, work);
		expect(executions).toBe(2);
		expect(third).toEqual({ replayed: true, result: { orderId: "o-2" } });
	});

	it("surfaces a concurrent in-flight duplicate as a retryable error", async () => {
		const deps = createDeps();
		let releaseFirst: () => void = () => {};
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = withIdempotentCommit(deps, request, async () => {
			await firstBlocked;
			return "first";
		});
		// Give the first execution time to claim.
		await new Promise((resolve) => setTimeout(resolve, 0));

		const second = withIdempotentCommit(deps, request, async () => "second");
		await expect(second).rejects.toBeInstanceOf(IdempotencyInFlightError);
		await expect(second).rejects.toMatchObject({ retryable: true });

		releaseFirst();
		await expect(first).resolves.toEqual({
			replayed: false,
			result: "first",
		});
	});

	it("composes with RetryingTransactionScope: a retryable attempt failure releases its claim and the retry runs fresh", async () => {
		const deps = {
			...createDeps(),
			scope: new RetryingTransactionScope(scope(), {
				maxAttempts: 3,
				baseDelayMs: 1,
			}),
		};
		let executions = 0;

		const outcome = await withIdempotentCommit(deps, request, async () => {
			executions++;
			if (executions === 1) {
				throw new ConcurrencyConflictError({
					reason: "stale_version",
					identity: { aggregateType: "Order", aggregateId: "o-1" },
					expectedVersion: 1,
					actualVersion: 2,
				});
			}
			return "second attempt";
		});

		expect(executions).toBe(2);
		expect(outcome).toEqual({ replayed: false, result: "second attempt" });
	});

	it("propagates the work error and reports the abandon failure", async () => {
		const abandonFailure = new Error("abandon failed");
		const reported: unknown[] = [];
		const deps = {
			...createDeps(),
			onIdempotencyError: (error: unknown) => {
				reported.push(error);
			},
		};
		deps.idempotency.abandon = async () => {
			throw abandonFailure;
		};

		await expect(
			withIdempotentCommit(deps, request, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(reported).toEqual([abandonFailure]);
	});

	it("does not abandon when the claim itself was the failure", async () => {
		const deps = createDeps();
		await withIdempotentCommit(deps, request, async () => "first");
		let abandoned = false;
		const originalAbandon = deps.idempotency.abandon.bind(deps.idempotency);
		deps.idempotency.abandon = async (claim) => {
			abandoned = true;
			return originalAbandon(claim);
		};

		await expect(
			withIdempotentCommit(
				deps,
				{ key: request.key, fingerprint: "fp-OTHER" },
				async () => "x",
			),
		).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
		expect(abandoned).toBe(false);
	});

	it("renews a leased claim while the transaction remains in flight", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
		const idempotency = new InMemoryLeasedIdempotencyStore<undefined>({
			claimTokenFactory: tokenFactory(),
			leaseDurationMs: 100,
			renewAfterMs: 40,
		});
		let entered!: () => void;
		const workEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execution = withIdempotentCommit(
			createDeps(idempotency),
			{ key: "key", fingerprint: "fp" },
			async () => {
				entered();
				await blocked;
				return "done";
			},
		);
		await workEntered;

		await vi.advanceTimersByTimeAsync(250);
		await expect(
			idempotency.claim(undefined, "key", "fp"),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_IN_FLIGHT" });

		release();
		await expect(execution).resolves.toEqual({
			replayed: false,
			result: "done",
		});
	});

	it("rolls back and releases the claim when lease renewal fails", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
		const idempotency = new InMemoryLeasedIdempotencyStore<undefined>({
			claimTokenFactory: tokenFactory(),
			leaseDurationMs: 100,
			renewAfterMs: 40,
		});
		const renewalFailure = new Error("lease store unavailable");
		idempotency.renew = async () => {
			throw renewalFailure;
		};
		let entered!: () => void;
		const workEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execution = withIdempotentCommit(
			createDeps(idempotency),
			{ key: "key", fingerprint: "fp" },
			async () => {
				entered();
				await blocked;
				return "must roll back";
			},
		);
		await workEntered;
		await vi.advanceTimersByTimeAsync(40);
		release();

		await expect(execution).rejects.toBe(renewalFailure);
		await expect(
			idempotency.claim(undefined, "key", "fp"),
		).resolves.toMatchObject({ status: "claimed" });
	});

	it("uses the source of truth to replay a committed staged outcome without re-running work", async () => {
		const clock = mutableClock();
		const idempotency = leasedStore(clock);
		const request = { key: "key", fingerprint: "fp" };
		const claim = claimedHandle(
			await idempotency.claim(undefined, request.key, request.fingerprint),
		);
		await idempotency.complete(undefined, claim, { orderId: "o-1" });
		clock.advance(101);
		let executions = 0;
		const reconciled: IdempotencyReconciliation[] = [];

		const result = await withIdempotentCommit(
			{
				...createDeps(idempotency),
				reconcileIdempotency: async (receipt) => {
					reconciled.push(receipt);
					return "committed" as const;
				},
			},
			request,
			async () => {
				executions++;
				return { orderId: "wrong" };
			},
		);

		expect(result).toEqual({ replayed: true, result: { orderId: "o-1" } });
		expect(executions).toBe(0);
		expect(reconciled).toHaveLength(1);
	});

	it("releases a proven non-commit and exposes the successor token to fresh work", async () => {
		const clock = mutableClock();
		const idempotency = leasedStore(clock);
		const request = { key: "key", fingerprint: "fp" };
		const original = claimedHandle(
			await idempotency.claim(undefined, request.key, request.fingerprint),
		);
		await idempotency.complete(undefined, original, "rolled back");
		clock.advance(101);
		let executionToken: string | undefined;

		const result = await withIdempotentCommit(
			{
				...createDeps(idempotency),
				reconcileIdempotency: async () => "not-committed" as const,
			},
			request,
			async (_ctx, _registration, execution) => {
				executionToken = execution.claimToken;
				return "fresh";
			},
		);

		expect(result).toEqual({ replayed: false, result: "fresh" });
		expect(executionToken).toEqual(expect.any(String));
		expect(executionToken).not.toBe(original.token);
	});

	it("reports post-commit confirmation failure without rejecting committed work", async () => {
		const clock = mutableClock();
		const idempotency = leasedStore(clock);
		const confirmFailure = new Error("confirm unavailable");
		idempotency.confirm = async () => {
			throw confirmFailure;
		};
		const reported: Array<{
			error: unknown;
			operation: string;
			key: string;
			token: string;
		}> = [];

		const result = await withIdempotentCommit(
			{
				...createDeps(idempotency),
				onIdempotencyError: (error, context) => {
					reported.push({ error, ...context });
				},
			},
			{ key: "key", fingerprint: "fp" },
			async () => "committed",
		);

		expect(result).toEqual({ replayed: false, result: "committed" });
		expect(reported).toEqual([
			{
				error: confirmFailure,
				operation: "confirm",
				key: "key",
				token: expect.any(String),
			},
		]);
	});

	it("keeps an unknown staged outcome blocked and fails loud", async () => {
		const clock = mutableClock();
		const idempotency = leasedStore(clock);
		const request = { key: "key", fingerprint: "fp" };
		const claim = claimedHandle(
			await idempotency.claim(undefined, request.key, request.fingerprint),
		);
		await idempotency.complete(undefined, claim, "uncertain");
		clock.advance(101);

		await expect(
			withIdempotentCommit(
				createDeps(idempotency),
				request,
				async () => "must not run",
			),
		).rejects.toMatchObject({
			code: "IDEMPOTENCY_RECONCILIATION_REQUIRED",
		});

		expect(await idempotency.claim(undefined, "key", "fp")).toMatchObject({
			status: "reconciliation-required",
		});
	});
});
