import { describe, expect, it } from "vite-plus/test";
import { InMemoryIdempotencyStore } from "../app/in-memory-idempotency-store";
import {
	createIdempotencyStoreContractTests,
	type IdempotencyStoreContractHarness,
} from "./idempotency-store-contract";

function createInMemoryHarness(): IdempotencyStoreContractHarness<undefined> {
	return {
		createEnvironment: async () => {
			let now = new Date("2026-07-14T10:00:00.000Z");
			let token = 0;
			return {
				store: new InMemoryIdempotencyStore<undefined>({
					clock: () => new Date(now),
					claimTokenFactory: () => `claim-${++token}`,
					leaseDurationMs: 100,
					renewAfterMs: 40,
				}),
				run: (work) => work(undefined),
				expireLease: async (claim) => {
					if (!claim.lease) throw new Error("leased claim expected");
					now = new Date(new Date(claim.lease.expiresAt).getTime() + 1);
				},
				advanceTimeTo: async (instant) => {
					now = new Date(instant);
				},
			};
		},
		// The in-memory store cannot see commits: complete() stages, confirm()
		// finalizes, abandon() compensates, and leases make crashes recoverable.
		family: "non-transactional",
	};
}

describe("idempotency-store contract suite against InMemoryIdempotencyStore", () => {
	const tests = createIdempotencyStoreContractTests(createInMemoryHarness());

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("the non-transactional family skips exactly the rollback test", () => {
		const skipped = tests.filter((test) => test.skipped);
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"family: transactional",
		]);
	});

	it("the transactional family runs the rollback proof and skips the leased-store tests", () => {
		const harness = createInMemoryHarness();
		harness.family = "transactional";
		const transactionalTests = createIdempotencyStoreContractTests(harness);

		const skipped = transactionalTests.filter((test) => test.skipped);
		// In-flight (sequentially unprovable for the single-transaction
		// pattern), four lease/reconciliation proofs, plus the three
		// leased-store lifecycle proofs.
		expect(skipped.map((test) => test.skipped?.capability)).toEqual([
			"family: non-transactional",
			"family: non-transactional",
			"family: non-transactional",
			"family: non-transactional",
			"family: non-transactional",
			"family: non-transactional",
			"family: non-transactional",
			"family: non-transactional",
		]);

		const active = transactionalTests
			.filter((test) => !test.skipped)
			.map((test) => test.name);
		expect(active).toContain(
			"a rolled-back transaction releases the claim (single-transaction pattern)",
		);
		expect(active).toContain(
			"a committed complete replays even without confirm (commit is the finalize)",
		);
	});

	it("the transactional rollback test demands runRolledBack from the environment", async () => {
		const harness = createInMemoryHarness();
		harness.family = "transactional";
		const transactionalTests = createIdempotencyStoreContractTests(harness);
		const rollbackTest = transactionalTests.find(
			(test) =>
				!test.skipped && test.name.startsWith("a rolled-back transaction"),
		);
		// The in-memory environment provides no runRolledBack, so the test
		// must fail loudly instead of passing vacuously.
		await expect(rollbackTest?.run()).rejects.toThrow("runRolledBack");
	});
});
