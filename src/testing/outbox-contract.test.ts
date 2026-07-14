import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { InMemoryOutbox } from "../events/outbox";
import type { Outbox } from "../events/ports";
import {
	createOutboxContractTests,
	type OutboxContractHarness,
} from "./outbox-contract";

type TestEvent = DomainEvent<"ThingHappened", { n: number }>;

const MAX_ATTEMPTS = 3;

function createInMemoryHarness(): OutboxContractHarness<TestEvent> {
	return {
		createEnvironment: async () => {
			const outbox = new InMemoryOutbox<TestEvent>({
				maxDeliveryAttempts: MAX_ATTEMPTS,
			});
			return {
				outbox,
				addCommitted: (events) => outbox.add(events),
				// No addRolledBack: the in-memory outbox cannot keep rollback
				// purity (documented limitation); the test stays visible as
				// skipped.
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
	};
}

describe("outbox contract suite against InMemoryOutbox", () => {
	const tests = createOutboxContractTests(createInMemoryHarness());

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("only the rollback-purity test is skipped for the in-memory reference", () => {
		const skipped = tests.filter((test) => test.skipped);
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"providesRolledBackAdds",
		]);
	});

	it("pins the source-position integrity laws in the portable suite", () => {
		expect(tests.map((test) => test.name)).toEqual(
			expect.arrayContaining([
				"finalizes complete commit receipts and links the next eventful commit",
				"rejects different event identities at one qualified source position",
				"keeps event-source heads isolated by aggregate type and id",
			]),
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
		expect(skipped.length).toBe(5); // rollback + four tracking tests
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
			"providesRolledBackAdds",
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
			"providesRolledBackAdds",
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
			"providesRolledBackAdds",
		]);
	});
});
