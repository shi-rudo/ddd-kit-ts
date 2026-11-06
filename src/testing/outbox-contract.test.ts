import { describe, expect, it } from "vite-plus/test";
import type { AggregateIdentity } from "../domain/aggregate/aggregate-identity";
import {
	createDomainEvent,
	type DomainEvent,
} from "../domain/event/domain-event";
import type { EventCommitCandidate } from "../messaging/committed-event";
import { InMemoryOutbox } from "../messaging/outbox/outbox";
import type { Outbox, OutboxRecord } from "../messaging/outbox/ports";
import { InMemoryTransactionScope } from "../persistence/repository/adapters/in-memory-transaction-scope";
import type { InMemoryTransaction } from "../persistence/repository/in-memory-transaction";
import {
	createOutboxContractTests,
	type OutboxContractHarness,
} from "./outbox-contract";

type TestEvent = DomainEvent<"ThingHappened", { n: number }>;

const MAX_ATTEMPTS = 3;
const ROLLBACK = Symbol("rollback");

/** An outbox whose rollback keeps the writes: the rollback tests must reject it. */
class OutboxKeepingRolledBackWrites extends InMemoryOutbox<TestEvent> {
	override beginTransaction(): InMemoryTransaction {
		const transaction = super.beginTransaction();
		return {
			commit: () => transaction.commit(),
			rollback: () => transaction.commit(),
		};
	}
}

/** An outbox whose `add` revives a dead letter: the requeue tests must reject it. */
class OutboxRequeuingOnAdd extends InMemoryOutbox<TestEvent> {
	override async add(
		events: ReadonlyArray<EventCommitCandidate<TestEvent>>,
	): Promise<void> {
		await super.add(events);
		await this.requeueDeadLetters(events.map(({ event }) => event.eventId));
	}
}

/** A port-legal outbox without the eventId dedupe: it rejects an exact retry of add. */
class OutboxRejectingAnExactRetry extends InMemoryOutbox<TestEvent> {
	private readonly addedIds = new Set<string>();

	override async add(
		events: ReadonlyArray<EventCommitCandidate<TestEvent>>,
	): Promise<void> {
		for (const { event } of events) {
			if (this.addedIds.has(event.eventId)) {
				throw new Error(`event ${event.eventId} is already in the outbox`);
			}
		}
		await super.add(events);
		for (const { event } of events) this.addedIds.add(event.eventId);
	}
}

/** An outbox that requeues every dead letter: the requeue tests must reject it. */
class OutboxRequeuingEveryDeadLetter extends InMemoryOutbox<TestEvent> {
	override async requeueDeadLetters(): Promise<void> {
		const deadLetters = await this.deadLetters();
		await super.requeueDeadLetters(deadLetters.map((r) => r.dispatchId));
	}
}

/** An outbox that finalizes a requeued record again: the requeue tests must reject it. */
class OutboxRefinalizingARequeue extends InMemoryOutbox<TestEvent> {
	private readonly requeuedIds = new Set<string>();

	override async requeueDeadLetters(
		dispatchIds: ReadonlyArray<string>,
	): Promise<void> {
		await super.requeueDeadLetters(dispatchIds);
		for (const id of dispatchIds) this.requeuedIds.add(id);
	}

	override async getPending(
		limit?: number,
	): Promise<ReadonlyArray<OutboxRecord<TestEvent>>> {
		const pending = await super.getPending(limit);
		return pending.map((record) =>
			this.requeuedIds.has(record.dispatchId)
				? {
						...record,
						position: {
							...record.position,
							previousEventfulAggregateVersion:
								record.position.aggregateVersion,
						},
					}
				: record,
		);
	}
}

/** An outbox without the requeue method: the suite must name the gap. */
class OutboxWithoutRequeue extends InMemoryOutbox<TestEvent> {
	override requeueDeadLetters =
		undefined as unknown as InMemoryOutbox<TestEvent>["requeueDeadLetters"];
}

/** A port-legal outbox that returns one record per poll. */
class OutboxWithShortPages extends InMemoryOutbox<TestEvent> {
	override async getPending(): Promise<ReadonlyArray<OutboxRecord<TestEvent>>> {
		return super.getPending(1);
	}
}

/** An outbox that returns a requeued record last: the requeue tests must reject it. */
class OutboxRequeuingAtTheTail extends InMemoryOutbox<TestEvent> {
	private readonly requeuedIds = new Set<string>();

	override async requeueDeadLetters(
		dispatchIds: ReadonlyArray<string>,
	): Promise<void> {
		await super.requeueDeadLetters(dispatchIds);
		for (const id of dispatchIds) this.requeuedIds.add(id);
	}

	override async getPending(
		limit?: number,
	): Promise<ReadonlyArray<OutboxRecord<TestEvent>>> {
		const pending = await super.getPending();
		const isRequeued = (record: OutboxRecord<TestEvent>) =>
			this.requeuedIds.has(record.dispatchId);
		return [
			...pending.filter((record) => !isRequeued(record)),
			...pending.filter(isRequeued),
		].slice(0, limit);
	}
}

function createInMemoryHarness(
	createOutbox = () =>
		new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: MAX_ATTEMPTS }),
): OutboxContractHarness<TestEvent> {
	return {
		createEnvironment: async () => {
			const outbox = createOutbox();
			const scope = new InMemoryTransactionScope([outbox]);
			const rolledBack = (write: () => Promise<void>) =>
				scope
					.transactional(async () => {
						await write();
						throw ROLLBACK;
					})
					.catch((error: unknown) => {
						if (error !== ROLLBACK) throw error;
					});
			return {
				outbox,
				addCommitted: (events) => scope.transactional(() => outbox.add(events)),
				addRolledBack: (events) => rolledBack(() => outbox.add(events)),
				endEventSourcesCommitted: (sources) =>
					scope.transactional(() => outbox.endEventSources(sources)),
				endEventSourcesRolledBack: (sources) =>
					rolledBack(() => outbox.endEventSources(sources)),
			};
		},
		createEvent: (seed) =>
			createDomainEvent(
				"ThingHappened",
				{ n: seed },
				{ eventId: `evt-${seed}` },
			),
		failuresToDeadLetter: MAX_ATTEMPTS,
		// The in-memory reference dedupes on eventId and does not claim.
		dedupesOnEventId: true,
		providesRolledBackAdds: true,
		providesRolledBackEnds: true,
	};
}

describe("outbox contract suite against InMemoryOutbox", () => {
	const tests = createOutboxContractTests(createInMemoryHarness());

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("no test is skipped for the in-memory reference", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});

	it("the rollback tests reject an outbox whose rollback keeps the writes", async () => {
		const mutantTests = createOutboxContractTests(
			createInMemoryHarness(
				() =>
					new OutboxKeepingRolledBackWrites({
						maxDeliveryAttempts: MAX_ATTEMPTS,
					}),
			),
		);
		const rollbackTests = mutantTests.filter((test) =>
			test.name.startsWith("a rolled-back"),
		);

		expect(rollbackTests).toHaveLength(2);
		for (const test of rollbackTests) {
			await expect(test.run()).rejects.toThrow(/Contract violated/);
		}
	});

	it("pins the source-position integrity laws in the portable suite", () => {
		expect(tests.map((test) => test.name)).toEqual(
			expect.arrayContaining([
				"finalizes complete commit receipts and links the next eventful commit",
				"rejects different event identities at one qualified source position",
				"keeps event-source heads isolated by aggregate type and id",
				"rejects a new event of an ended event source",
			]),
		);
	});

	it("the ended-source law kills an adapter that ignores endEventSources", async () => {
		const mutant = createInMemoryHarness();
		const createEnvironment = mutant.createEnvironment;
		mutant.createEnvironment = async () => {
			const environment = await createEnvironment();
			return { ...environment, endEventSourcesCommitted: async () => {} };
		};
		const endedSourceTest = createOutboxContractTests(mutant).find(
			(test) => test.name === "rejects a new event of an ended event source",
		);
		expect(endedSourceTest).toBeDefined();
		await expect(endedSourceTest?.run()).rejects.toThrow(
			/a new event of an ended event source must reject/,
		);
	});

	it("the ended-source law kills an adapter that keys the end mark by aggregate type only", async () => {
		const mutant = createInMemoryHarness();
		const createEnvironment = mutant.createEnvironment;
		mutant.createEnvironment = async () => {
			const environment = await createEnvironment();
			const knownSources: AggregateIdentity[] = [];
			return {
				...environment,
				addCommitted: async (events) => {
					for (const { source } of events) knownSources.push(source);
					await environment.addCommitted(events);
				},
				endEventSourcesCommitted: (sources) =>
					environment.endEventSourcesCommitted(
						knownSources.filter((known) =>
							sources.some(
								(source) => source.aggregateType === known.aggregateType,
							),
						),
					),
			};
		};
		const endedSourceTest = createOutboxContractTests(mutant).find(
			(test) => test.name === "rejects a new event of an ended event source",
		);
		expect(endedSourceTest).toBeDefined();
		await expect(endedSourceTest?.run()).rejects.toThrow(
			/ending one source must not end another/,
		);
	});

	it("the source-chain law kills an adapter that drops every predecessor", async () => {
		const mutant = createInMemoryHarness();
		const createEnvironment = mutant.createEnvironment;
		mutant.createEnvironment = async () => {
			const environment = await createEnvironment();
			const realOutbox = environment.outbox as Outbox<TestEvent>;
			const outbox: Outbox<TestEvent> = {
				add: (events) => realOutbox.add(events, undefined),
				getPending: async (limit) =>
					(await realOutbox.getPending(limit)).map((record) => ({
						...record,
						position: {
							...record.position,
							previousEventfulAggregateVersion: null,
						},
					})),
				markDispatched: (ids) => realOutbox.markDispatched(ids),
				endEventSources: (sources) =>
					realOutbox.endEventSources(sources, undefined),
			};
			return { ...environment, outbox };
		};
		const sourceChainTest = createOutboxContractTests(mutant).find(
			(test) =>
				test.name ===
				"finalizes complete commit receipts and links the next eventful commit",
		);
		expect(sourceChainTest).toBeDefined();
		await expect(sourceChainTest?.run()).rejects.toThrow(
			/links? the next eventful commit|link the next eventful commit/i,
		);
	});

	it("the requeue tests kill an adapter whose add revives a dead letter", async () => {
		const mutant = createInMemoryHarness(
			() => new OutboxRequeuingOnAdd({ maxDeliveryAttempts: MAX_ATTEMPTS }),
		);
		const retryTest = createOutboxContractTests(mutant).find(
			(test) => test.name === "an exact retry of add leaves a dead letter dead",
		);
		expect(retryTest).toBeDefined();
		await expect(retryTest?.run()).rejects.toThrow(
			/a late retry of add must not revive a dead letter/,
		);
	});

	it("the dead-letter retry test accepts a port-legal adapter that rejects an exact retry", async () => {
		const withoutDedupe = createInMemoryHarness(
			() =>
				new OutboxRejectingAnExactRetry({ maxDeliveryAttempts: MAX_ATTEMPTS }),
		);
		withoutDedupe.dedupesOnEventId = undefined;
		const retryTest = createOutboxContractTests(withoutDedupe).find(
			(test) => test.name === "an exact retry of add leaves a dead letter dead",
		);

		await expect(retryTest?.run()).resolves.toBeUndefined();
	});

	it("the requeue tests kill an adapter that returns a requeued record last", async () => {
		const mutant = createInMemoryHarness(
			() => new OutboxRequeuingAtTheTail({ maxDeliveryAttempts: MAX_ATTEMPTS }),
		);
		const orderTest = createOutboxContractTests(mutant).find(
			(test) =>
				test.name === "a requeued record returns to its commit-order place",
		);
		expect(orderTest).toBeDefined();
		await expect(orderTest?.run()).rejects.toThrow(
			/must return a requeued record before its successor/,
		);
	});

	it("the requeue tests kill an adapter that requeues every dead letter", async () => {
		const mutant = createInMemoryHarness(
			() =>
				new OutboxRequeuingEveryDeadLetter({
					maxDeliveryAttempts: MAX_ATTEMPTS,
				}),
		);
		const namedIdsTest = createOutboxContractTests(mutant).find(
			(test) =>
				test.name === "requeueDeadLetters moves only the named dead letters",
		);
		expect(namedIdsTest).toBeDefined();
		await expect(namedIdsTest?.run()).rejects.toThrow(
			/must leave every other dead letter dead/,
		);
	});

	it("the requeue tests kill an adapter that finalizes a requeued record again", async () => {
		const mutant = createInMemoryHarness(
			() =>
				new OutboxRefinalizingARequeue({ maxDeliveryAttempts: MAX_ATTEMPTS }),
		);
		const budgetTest = createOutboxContractTests(mutant).find((test) =>
			test.name.startsWith("requeueDeadLetters returns a dead letter"),
		);
		await expect(budgetTest?.run()).rejects.toThrow(
			/must keep its commit position/,
		);
	});

	it("names a tracking outbox without requeueDeadLetters", async () => {
		const mutant = createInMemoryHarness(
			() => new OutboxWithoutRequeue({ maxDeliveryAttempts: MAX_ATTEMPTS }),
		);
		const budgetTest = createOutboxContractTests(mutant).find((test) =>
			test.name.startsWith("requeueDeadLetters returns a dead letter"),
		);
		await expect(budgetTest?.run()).rejects.toThrow(
			/must implement requeueDeadLetters/,
		);
	});

	it("the order test accepts a port-legal adapter with short pages", async () => {
		const shortPages = createInMemoryHarness(
			() => new OutboxWithShortPages({ maxDeliveryAttempts: MAX_ATTEMPTS }),
		);
		const orderTest = createOutboxContractTests(shortPages).find(
			(test) =>
				test.name === "a requeued record returns to its commit-order place",
		);
		await expect(orderTest?.run()).resolves.toBeUndefined();
	});

	it("a plain-outbox harness marks the tracking tests as skipped, with a loud run()", async () => {
		const plain = createInMemoryHarness();
		plain.failuresToDeadLetter = undefined;
		const plainTests = createOutboxContractTests(plain);
		const skipped = plainTests.filter((test) => test.skipped);
		expect(skipped.length).toBe(10); // the ten tracking tests
		await expect(skipped[1]?.run()).rejects.toThrow("skipped");
	});

	it("a claiming-getPending harness skips every un-acked re-poll test", () => {
		const claiming = createInMemoryHarness();
		claiming.claimsOnGetPending = true;
		const claimingTests = createOutboxContractTests(claiming);
		const skipped = claimingTests.filter((test) => test.skipped);
		// Head stability, re-ack non-disturbance, attempts surfacing, and the
		// requeue of a pending record all re-poll records an earlier poll
		// returned without resolving them.
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"non-claiming getPending",
			"non-claiming getPending",
			"non-claiming getPending",
			"non-claiming getPending",
		]);
	});

	it("a ceiling-of-one harness skips the tests that observe the attempts of a pending record", () => {
		const immediate = createInMemoryHarness();
		immediate.failuresToDeadLetter = 1;
		const immediateTests = createOutboxContractTests(immediate);
		const skipped = immediateTests.filter((test) => test.skipped);
		// A single markFailed dead-letters the record before any re-poll
		// could observe its attempt count; the other tracking tests run.
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"failuresToDeadLetter >= 2",
			"failuresToDeadLetter >= 2",
		]);
	});

	it("a harness without the eventId unique key skips the dedupe tests", () => {
		const noDedupe = createInMemoryHarness();
		noDedupe.dedupesOnEventId = undefined;
		const noDedupeTests = createOutboxContractTests(noDedupe);
		const skipped = noDedupeTests.filter((test) => test.skipped);
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"dedupesOnEventId",
			"dedupesOnEventId",
		]);
	});
});
