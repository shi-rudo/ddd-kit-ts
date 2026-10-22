import { describe, expect, it } from "vite-plus/test";
import type { Version } from "../../domain/aggregate/aggregate";
import { StateStoredAggregate } from "../../domain/aggregate/state-stored-aggregate";
import {
	type AnyDomainEvent,
	createDomainEvent,
	createDomainEventFactory,
	type DomainEvent,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	ConcurrencyConflictError,
	EventCollectionError,
	IdempotencyKeyReuseError,
} from "../../errors/kit-errors";
import type { EventCommitCandidate } from "../../messaging/committed-event";
import { InMemoryOutbox } from "../../messaging/outbox/outbox";
import { InMemoryTransactionScope } from "../../persistence/repository/adapters/in-memory-transaction-scope";
import { RetryingTransactionScope } from "../../persistence/repository/retrying-scope";
import type { CommitRegistration } from "../cqrs/handler";
import { InMemoryIdempotencyStore } from "./adapters/in-memory-idempotency-store";
import { withIdempotentCommit } from "./idempotency";

type OrderId = Id<"OrderId">;
type OrderEvent = DomainEvent<"OrderConfirmed", { orderId: string }>;
type OrderState = { status: "open" | "confirmed" };

class Order extends StateStoredAggregate<OrderState, OrderId, OrderEvent> {
	protected readonly aggregateType = "Order";

	constructor(id: OrderId) {
		super(id, { status: "open" });
	}

	/** Records the decision unstamped, as a domain method does. */
	decideConfirmation(): void {
		this.setState(
			{ ...this.state, status: "confirmed" },
			this.createEvent("OrderConfirmed", { orderId: this.id }),
		);
	}

	confirm(): void {
		this.setState(
			{ ...this.state, status: "confirmed" },
			createDomainEvent(
				"OrderConfirmed",
				{ orderId: this.id },
				{
					aggregateId: this.id,
					aggregateType: this.aggregateType,
				},
			),
		);
	}
}

function createDeps(outbox = new InMemoryOutbox<AnyDomainEvent>()) {
	const idempotency = new InMemoryIdempotencyStore<undefined>();
	return {
		outbox,
		scope: new InMemoryTransactionScope([idempotency, outbox]),
		idempotency,
	};
}

const request = { key: "req-1", fingerprint: "fp-1" };

describe("withIdempotentCommit with a transactional store", () => {
	it("runs the work fresh, stores the outcome, and collects events", async () => {
		const deps = createDeps();
		const order = new Order("o-1" as OrderId);

		const outcome = await withIdempotentCommit(
			deps,
			request,
			async (_ctx, registration) => {
				order.confirm();
				registration.registerSaved(order);
				return { orderId: order.id };
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
			registration: CommitRegistration<AnyDomainEvent>,
		) => {
			executions++;
			const order = new Order("o-1" as OrderId);
			order.confirm();
			registration.registerSaved(order);
			return { orderId: order.id };
		};

		await withIdempotentCommit(deps, request, work);
		const replayed = await withIdempotentCommit(deps, request, work);

		expect(executions).toBe(1);
		expect(replayed).toEqual({ replayed: true, result: { orderId: "o-1" } });
		// No second collection: the duplicate emitted no events.
		expect(await deps.outbox.getPending()).toHaveLength(1);
	});

	it("a concurrent duplicate waits for the first execution and replays its outcome", async () => {
		const deps = createDeps();
		let releaseFirst: () => void = () => {};
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = withIdempotentCommit(deps, request, async () => {
			await firstBlocked;
			return "first";
		});
		const second = withIdempotentCommit(deps, request, async () => "second");

		releaseFirst();

		await expect(first).resolves.toEqual({ replayed: false, result: "first" });
		await expect(second).resolves.toEqual({ replayed: true, result: "first" });
	});

	it("rejects the same key with a different fingerprint", async () => {
		const deps = createDeps();
		await withIdempotentCommit(deps, request, async () => "first");

		await expect(
			withIdempotentCommit(
				deps,
				{ key: request.key, fingerprint: "fp-OTHER" },
				async () => "second",
			),
		).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
	});

	it("releases the claim through the rollback when the work fails, so a retry runs fresh", async () => {
		const deps = createDeps();
		const order = new Order("o-failed" as OrderId);
		order.confirm();

		await expect(
			withIdempotentCommit(deps, request, async (_ctx, registration) => {
				registration.registerSaved(order);
				throw new Error("work failed");
			}),
		).rejects.toThrow("work failed");
		expect(order.pendingEvents).toHaveLength(1);
		expect(await deps.outbox.getPending()).toEqual([]);

		await expect(
			withIdempotentCommit(deps, request, async () => "retry"),
		).resolves.toEqual({ replayed: false, result: "retry" });
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
		const deps = createDeps(new FlakyOutbox());
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

		// complete() runs, then the outbox write fails inside the transaction.
		// The rollback must take the stored outcome with it.
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

	it("composes with RetryingTransactionScope: a retryable attempt failure releases its claim and the retry runs fresh", async () => {
		const idempotency = new InMemoryIdempotencyStore<undefined>();
		const outbox = new InMemoryOutbox<AnyDomainEvent>();
		const deps = {
			outbox,
			scope: new RetryingTransactionScope(
				new InMemoryTransactionScope([idempotency, outbox]),
				{ maxAttempts: 3, baseDelayMs: 1 },
			),
			idempotency,
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

	it("seals the user registration capability before idempotency completion", async () => {
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
		deps.idempotency.complete = async (ctx, claim, outcome) => {
			await originalComplete(ctx, claim, outcome);
			signalCompleteStarted();
			await completeBlocked;
		};

		let leaked: CommitRegistration<AnyDomainEvent> | undefined;
		const execution = withIdempotentCommit(
			deps,
			request,
			async (_ctx, registration) => {
				leaked = registration;
				return "ok";
			},
		);
		await completeStarted;

		expect(() => leaked?.registerSaved(new Order("o-late" as OrderId))).toThrow(
			EventCollectionError,
		);
		releaseComplete();
		await expect(execution).resolves.toEqual({ replayed: false, result: "ok" });
	});

	it("passes the registration options to withCommit, so a contradicting re-registration rejects", async () => {
		const deps = createDeps();
		const order = new Order("o-1" as OrderId);

		const execution = withIdempotentCommit(
			deps,
			request,
			async (_ctx, registration) => {
				order.confirm();
				registration.registerSaved(order, {
					expectedVersion: 0 as Version,
				});
				registration.registerSaved(order, { expectedVersion: 1 as Version });
				return order.id;
			},
		);

		await expect(execution).rejects.toBeInstanceOf(EventCollectionError);
		expect(await deps.outbox.getPending()).toHaveLength(0);
	});

	it("stamps with the factory and the shared stamp options of its dependencies", async () => {
		const deps = {
			...createDeps(),
			eventStampFactory: createDomainEventFactory({
				eventIdFactory: () => "evt-1",
			}),
			stampOptions: { metadata: { correlationId: "corr-1" } },
		};
		const order = new Order("o-1" as OrderId);
		order.decideConfirmation();

		await withIdempotentCommit(deps, request, async (_ctx, registration) => {
			registration.registerSaved(order);
			return order.id;
		});

		const [record] = await deps.outbox.getPending();
		expect(record?.event.eventId).toBe("evt-1");
		expect(record?.event.metadata?.correlationId).toBe("corr-1");
	});

	it("passes the claim token to the work", async () => {
		const deps = createDeps();
		let claimToken: string | undefined;

		await withIdempotentCommit(
			deps,
			request,
			async (_ctx, _registration, execution) => {
				claimToken = execution.claimToken;
				return "done";
			},
		);

		expect(claimToken).toEqual(expect.any(String));
	});
});
