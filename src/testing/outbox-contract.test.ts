import { describe, expect, it } from "vite-plus/test";
import type { AggregateIdentity } from "../domain/aggregate/aggregate-identity";
import {
	createDomainEvent,
	type DomainEvent,
} from "../domain/event/domain-event";
import { InMemoryOutbox } from "../messaging/outbox/outbox";
import type { Outbox } from "../messaging/outbox/ports";
import { InMemoryTransactionScope } from "../persistence/repository/adapters/in-memory-transaction-scope";
import type { InMemoryTransaction } from "../persistence/repository/in-memory-transaction";
import {
	createOutboxContractTests,
	type OutboxContractHarness,
} from "./outbox-contract";

type TestEvent = DomainEvent<"ThingHappened", { n: number }>;

const MAX_ATTEMPTS = 3;
const ROLLBACK = Symbol("rollback");

/** An outbox whose rollback does nothing: the rollback tests must reject it. */
class OutboxWithoutRollback extends InMemoryOutbox<TestEvent> {
	override beginTransaction(): InMemoryTransaction {
		const transaction = super.beginTransaction();
		return { commit: () => transaction.commit(), rollback: () => {} };
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

	it("the rollback tests reject an outbox whose rollback does nothing", async () => {
		const mutantTests = createOutboxContractTests(
			createInMemoryHarness(
				() => new OutboxWithoutRollback({ maxDeliveryAttempts: MAX_ATTEMPTS }),
			),
		);
		const rollbackTests = mutantTests.filter((test) =>
			test.name.startsWith("a rolled-back"),
		);

		expect(rollbackTests).toHaveLength(2);
		for (const test of rollbackTests) {
			await expect(test.run()).rejects.toThrow();
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
			const realOutbox = environment.outbox;
			const outbox: Outbox<TestEvent> = {
				add: (events) => realOutbox.add(events),
				getPending: async (limit) =>
					(await realOutbox.getPending(limit)).map((record) => ({
						...record,
						position: {
							...record.position,
							previousEventfulAggregateVersion: null,
						},
					})),
				markDispatched: (ids) => realOutbox.markDispatched(ids),
				endEventSources: (sources) => realOutbox.endEventSources(sources),
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

	it("a plain-outbox harness marks the tracking tests as skipped, with a loud run()", async () => {
		const plain = createInMemoryHarness();
		plain.failuresToDeadLetter = undefined;
		const plainTests = createOutboxContractTests(plain);
		const skipped = plainTests.filter((test) => test.skipped);
		expect(skipped.length).toBe(4); // the four tracking tests
		await expect(skipped[1]?.run()).rejects.toThrow("skipped");
	});

	it("a claiming-getPending harness skips every un-acked re-poll test", () => {
		const claiming = createInMemoryHarness();
		claiming.claimsOnGetPending = true;
		const claimingTests = createOutboxContractTests(claiming);
		const skipped = claimingTests.filter((test) => test.skipped);
		// Head stability, re-ack non-disturbance, and attempts surfacing all
		// re-poll records an earlier poll returned without resolving them.
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"non-claiming getPending",
			"non-claiming getPending",
			"non-claiming getPending",
		]);
	});

	it("a ceiling-of-one harness skips the attempts-surfacing test", () => {
		const immediate = createInMemoryHarness();
		immediate.failuresToDeadLetter = 1;
		const immediateTests = createOutboxContractTests(immediate);
		const skipped = immediateTests.filter((test) => test.skipped);
		// A single markFailed dead-letters the record before any re-poll
		// could observe its attempt count; the other tracking tests run.
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"failuresToDeadLetter >= 2",
		]);
	});

	it("a harness without the eventId unique key skips the dedupe test", () => {
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
