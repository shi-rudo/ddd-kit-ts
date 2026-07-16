import { describe, expect, it } from "vite-plus/test";
import { InMemoryDeadlineStore } from "../deadlines/in-memory-deadline-store";
import {
	createDeadlineStoreContractTests,
	type DeadlineStoreContractHarness,
} from "./deadline-store-contract";

const CEILING = 3;

function createInMemoryHarness(): DeadlineStoreContractHarness {
	return {
		createEnvironment: async () => ({
			store: new InMemoryDeadlineStore({ maxDeliveryAttempts: CEILING }),
			run: (work) => work(),
			// No runRolledBack: the in-memory store is not transaction-aware
			// (documented limitation); the rollback tests stay visible as
			// skipped.
		}),
		failuresToDeadLetter: CEILING,
	};
}

describe("deadline-store contract suite against the in-memory reference", () => {
	const tests = createDeadlineStoreContractTests(createInMemoryHarness());

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("only the two rollback tests are skipped for the in-memory reference", () => {
		const skipped = tests.filter((test) => test.skipped);
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"providesRolledBackRuns",
			"providesRolledBackRuns",
		]);
	});

	it("a claiming-due harness skips every un-acked re-poll test", () => {
		const claiming = createInMemoryHarness();
		claiming.claimsOnDue = true;
		const claimingTests = createDeadlineStoreContractTests(claiming);
		const skipped = claimingTests.filter((test) => test.skipped);
		// Reschedule-race successor visibility, attempts/neighbor flow, and
		// the two rollback gates of the in-memory harness.
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"non-claiming due",
			"non-claiming due",
			"providesRolledBackRuns",
			"providesRolledBackRuns",
		]);
	});

	it("a ceiling below 2 is rejected at suite construction", () => {
		const harness = createInMemoryHarness();
		harness.failuresToDeadLetter = 1;
		expect(() => createDeadlineStoreContractTests(harness)).toThrow(
			/failuresToDeadLetter must be an integer >= 2/,
		);
	});
});
