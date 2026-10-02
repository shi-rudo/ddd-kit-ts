import { describe, expect, it } from "vite-plus/test";
import { InMemoryDeadlineStore } from "../application/deadlines/adapters/in-memory-deadline-store";
import {
	type InMemoryTransaction,
	InMemoryTransactionScope,
} from "../persistence/repository/adapters/in-memory-transaction-scope";
import {
	createDeadlineStoreContractTests,
	type DeadlineStoreContractEnvironment,
	type DeadlineStoreContractHarness,
} from "./deadline-store-contract";

type SuitePayload = Parameters<
	DeadlineStoreContractEnvironment["store"]["schedule"]
>[0]["payload"];

const CEILING = 3;
const ROLLBACK = Symbol("rollback");

/** A store whose rollback does nothing: the rollback tests must reject it. */
class DeadlineStoreWithoutRollback extends InMemoryDeadlineStore<SuitePayload> {
	override beginTransaction(): InMemoryTransaction {
		const transaction = super.beginTransaction();
		return { commit: () => transaction.commit(), rollback: () => {} };
	}
}

function createInMemoryHarness(
	createStore = () =>
		new InMemoryDeadlineStore<SuitePayload>({ maxDeliveryAttempts: CEILING }),
): DeadlineStoreContractHarness {
	return {
		createEnvironment: async () => {
			const store = createStore();
			const scope = new InMemoryTransactionScope([store]);
			return {
				store,
				run: (work) => scope.transactional(() => work()),
				runRolledBack: async (work) => {
					let result: Awaited<ReturnType<typeof work>> | undefined;
					await scope
						.transactional(async () => {
							result = await work();
							throw ROLLBACK;
						})
						.catch((error: unknown) => {
							if (error !== ROLLBACK) throw error;
						});
					return result as Awaited<ReturnType<typeof work>>;
				},
			};
		},
		failuresToDeadLetter: CEILING,
		providesRolledBackRuns: true,
	};
}

describe("deadline-store contract suite against the in-memory reference", () => {
	const tests = createDeadlineStoreContractTests(createInMemoryHarness());

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("no test is skipped for the in-memory reference", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});

	it("the rollback tests reject a store whose rollback does nothing", async () => {
		const mutantTests = createDeadlineStoreContractTests(
			createInMemoryHarness(
				() =>
					new DeadlineStoreWithoutRollback({ maxDeliveryAttempts: CEILING }),
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

	it("a claiming-due harness skips every un-acked re-poll test", () => {
		const claiming = createInMemoryHarness();
		claiming.claimsOnDue = true;
		const claimingTests = createDeadlineStoreContractTests(claiming);
		const skipped = claimingTests.filter((test) => test.skipped);
		// Reschedule-race successor visibility and attempts/neighbor flow.
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"non-claiming due",
			"non-claiming due",
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
