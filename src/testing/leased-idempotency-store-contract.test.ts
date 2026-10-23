import { describe, expect, it } from "vite-plus/test";
import { InMemoryLeasedIdempotencyStore } from "../application/idempotency/adapters/in-memory-leased-idempotency-store";
import {
	createLeasedIdempotencyStoreContractTests,
	type LeasedIdempotencyStoreContractHarness,
} from "./leased-idempotency-store-contract";

function createInMemoryHarness(): LeasedIdempotencyStoreContractHarness<undefined> {
	return {
		createEnvironment: async () => {
			let now = new Date("2026-07-14T10:00:00.000Z");
			let token = 0;
			return {
				store: new InMemoryLeasedIdempotencyStore<undefined>({
					clock: () => new Date(now),
					claimTokenFactory: () => `claim-${++token}`,
					leaseDurationMs: 100,
					renewAfterMs: 40,
				}),
				run: (work) => work(undefined),
				expireLease: async (claim) => {
					now = new Date(new Date(claim.lease.expiresAt).getTime() + 1);
				},
				advanceTimeTo: async (instant) => {
					now = new Date(instant);
				},
			};
		},
	};
}

describe("leased idempotency-store contract suite against InMemoryLeasedIdempotencyStore", () => {
	const tests = createLeasedIdempotencyStoreContractTests(
		createInMemoryHarness(),
	);

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("no test is skipped for the in-memory reference", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});
