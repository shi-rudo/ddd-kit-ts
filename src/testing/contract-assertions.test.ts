import { describe, expect, it } from "vite-plus/test";
import { ConcurrencyConflictError } from "../errors/kit-errors";
import {
	assertChainContainsKitError,
	assertRunPermitsOverlappingCalls,
	captureRejection,
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

describe("assertRunPermitsOverlappingCalls", () => {
	const boundMs = 50;

	const concurrentRun = (work: () => Promise<void>) => work();

	/** Queues every call behind the previous one, like a single connection. */
	const serializedRun = () => {
		let tail: Promise<unknown> = Promise.resolve();
		return (work: () => Promise<void>) => {
			const call = tail.then(work);
			tail = call.catch(() => undefined);
			return call;
		};
	};

	const settlesWithin = (promise: Promise<unknown>, ms: number) =>
		Promise.race([
			promise.then(() => "settled"),
			new Promise<string>((resolve) =>
				setTimeout(() => resolve("still open"), ms),
			),
		]);

	it("passes when a second call completes while the first call stays open", async () => {
		await expect(
			assertRunPermitsOverlappingCalls(concurrentRun, boundMs),
		).resolves.toBeUndefined();
	});

	it("fails within the bound and names the requirement when run serializes its calls", async () => {
		await expect(
			assertRunPermitsOverlappingCalls(serializedRun(), boundMs),
		).rejects.toThrow(
			/Contract violated: run must permit overlapping calls: a second run call did not complete within 50 ms/,
		);
	});

	it("releases the first call after a failed proof, so the environment can run the next call", async () => {
		const run = serializedRun();
		await captureRejection(assertRunPermitsOverlappingCalls(run, boundMs));

		const later = run(async () => {});

		await expect(settlesWithin(later, boundMs)).resolves.toBe("settled");
	});

	it("surfaces a second call that rejects within the bound", async () => {
		let calls = 0;
		const secondCallRejects = (work: () => Promise<void>) =>
			++calls === 1 ? work() : Promise.reject(new Error("pool closed"));

		await expect(
			assertRunPermitsOverlappingCalls(secondCallRejects, boundMs),
		).rejects.toThrow("pool closed");
	});

	it("surfaces a first call that rejects instead of waiting for it to open", async () => {
		const brokenRun = () => Promise.reject(new Error("no transaction"));

		await expect(
			assertRunPermitsOverlappingCalls(brokenRun, boundMs),
		).rejects.toThrow("no transaction");
	});

	it("surfaces a first call that dies while it stays open, even when the second call then completes", async () => {
		const run = serializedRun();
		let calls = 0;
		const firstCallDies = (work: () => Promise<void>) => {
			if (++calls > 1) return run(work);
			return run(() =>
				Promise.race([
					work(),
					new Promise<void>((_, reject) =>
						setTimeout(() => reject(new Error("idle in transaction")), 10),
					),
				]),
			);
		};

		await expect(
			assertRunPermitsOverlappingCalls(firstCallDies, boundMs),
		).rejects.toThrow("idle in transaction");
	});

	it("reports the timeout of the proof, not a rejection of the released first call", async () => {
		const run = serializedRun();
		const calls: Promise<unknown>[] = [];
		const firstCallRejectsAfterRelease = (work: () => Promise<void>) => {
			const call = run(work).then(() => {
				if (calls.length === 1) throw new Error("commit failed");
			});
			calls.push(call);
			return call;
		};

		await expect(
			assertRunPermitsOverlappingCalls(firstCallRejectsAfterRelease, boundMs),
		).rejects.toThrow(/run must permit overlapping calls/);
	});
});
