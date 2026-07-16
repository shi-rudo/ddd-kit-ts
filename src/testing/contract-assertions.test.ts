import { describe, expect, it } from "vite-plus/test";
import { ConcurrencyConflictError } from "../core/errors";
import {
	assertChainContainsKitError,
	describeError,
} from "./contract-assertions";

const conflict = () =>
	new ConcurrencyConflictError({
		aggregateType: "Order",
		aggregateId: "o-1",
		expectedVersion: 1,
		actualVersion: 2,
	});

/** Simulates an error from a pre-v3 kit copy: PascalCase name, no code. */
const legacyConflict = () => {
	const error = new Error("Concurrency conflict on Order(o-1)");
	error.name = "ConcurrencyConflictError";
	return error;
};

describe("assertChainContainsKitError", () => {
	it("passes when the code is found anywhere in the cause chain", () => {
		const wrapped = new Error("use case failed", { cause: conflict() });

		expect(() =>
			assertChainContainsKitError(
				wrapped,
				["CONCURRENCY_CONFLICT"],
				"stale writer must conflict",
			),
		).not.toThrow();
	});

	it("fails with the plain contract message when nothing matches", () => {
		expect(() =>
			assertChainContainsKitError(
				new Error("some driver error"),
				["CONCURRENCY_CONFLICT"],
				"stale writer must conflict",
			),
		).toThrow(/Contract violated: stale writer must conflict/);
	});

	it("never matches a legacy PascalCase name; the code is the only contract", () => {
		// The v3 suite certifies the v3 contract. An error from a pre-v3
		// kit copy must FAIL the assertion; the failure message renders the
		// cause-chain names, so the stale copy is visible without any
		// version knowledge baked into the suite.
		const rejection = new Error("wrapped", { cause: legacyConflict() });

		expect(() =>
			assertChainContainsKitError(
				rejection,
				["CONCURRENCY_CONFLICT"],
				`stale writer must conflict; got: ${describeError(rejection)}`,
			),
		).toThrow(/ConcurrencyConflictError/);
	});

	it("accepts any of several codes", () => {
		expect(() =>
			assertChainContainsKitError(
				conflict(),
				["CONCURRENCY_CONFLICT", "DUPLICATE_AGGREGATE"],
				"either conflict is acceptable",
			),
		).not.toThrow();
	});
});

describe("describeError", () => {
	it("renders the cause-chain names so wrapped failures are identifiable", () => {
		const rejection = new Error("use case failed", {
			cause: legacyConflict(),
		});

		expect(describeError(rejection)).toBe(
			"Error: use case failed (cause chain: Error -> ConcurrencyConflictError)",
		);
	});

	it("stays flat for errors without a cause", () => {
		expect(describeError(new Error("boom"))).toBe("Error: boom");
	});

	it("is cycle-safe", () => {
		const cyclic = new Error("a");
		(cyclic as { cause?: unknown }).cause = cyclic;

		expect(typeof describeError(cyclic)).toBe("string");
	});
});
