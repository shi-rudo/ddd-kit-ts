import { describe, expect, it } from "vite-plus/test";
import { ConcurrencyConflictError } from "../errors/kit-errors";
import {
	assertChainContainsKitError,
	assertRunPermitsOverlappingCalls,
	awaitOverlappingCall,
	captureRejection,
	describeError,
	parkRunCall,
} from "./contract-assertions";
import { serializedCalls } from "./serialized-calls";

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
	const serializedRun = serializedCalls;

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

	it("reports the exceeded bound, not a rejection of the released first call", async () => {
		const run = serializedRun();
		let calls = 0;
		let firstCallRejected = false;
		const firstCallRejectsAfterRelease = (work: () => Promise<void>) => {
			const index = calls++;
			return run(work).then(() => {
				if (index === 0) {
					firstCallRejected = true;
					throw new Error("commit failed");
				}
			});
		};

		await expect(
			assertRunPermitsOverlappingCalls(firstCallRejectsAfterRelease, boundMs),
		).rejects.toThrow(/run must permit overlapping calls/);
		expect(firstCallRejected).toBe(true);
	});
});

describe("parkRunCall", () => {
	it("resolves once the work holds and keeps the call open until release", async () => {
		let loaded = false;
		let flushed = false;

		const parked = await parkRunCall(async (hold) => {
			loaded = true;
			await hold();
			flushed = true;
		});

		expect(loaded).toBe(true);
		expect(flushed).toBe(false);

		parked.release();
		await parked.call;

		expect(flushed).toBe(true);
	});

	it("propagates a call that rejects before its work holds", async () => {
		await expect(
			parkRunCall(async () => {
				throw new Error("load failed");
			}),
		).rejects.toThrow("load failed");
	});

	it("fails when run resolves without awaiting its work", async () => {
		const fireAndForget = (work: () => Promise<void>) => {
			void work();
			return Promise.resolve();
		};

		await expect(parkRunCall((hold) => fireAndForget(hold))).rejects.toThrow(
			/run must await its work/,
		);
	});
});

describe("awaitOverlappingCall", () => {
	const boundMs = 50;

	const parkedCall = () => {
		let release!: () => void;
		let released = false;
		const call = new Promise<void>((resolve) => {
			release = () => {
				released = true;
				resolve();
			};
		});
		return { call, release, isReleased: () => released };
	};

	it("resolves with the value of the call and leaves the parked call parked", async () => {
		const parked = parkedCall();

		const value = await awaitOverlappingCall(
			() => Promise.resolve("committed"),
			parked,
			boundMs,
		);

		expect(value).toBe("committed");
		expect(parked.isReleased()).toBe(false);
	});

	it("releases the parked call and names the requirement when the call does not complete within the bound", async () => {
		const parked = parkedCall();
		const blockedBehindParked = parked.call.then(() => "late");

		await expect(
			awaitOverlappingCall(() => blockedBehindParked, parked, boundMs),
		).rejects.toThrow(/run must permit overlapping calls/);

		expect(parked.isReleased()).toBe(true);
		await expect(blockedBehindParked).resolves.toBe("late");
	});

	it("releases the parked call and propagates a rejection of the call", async () => {
		const parked = parkedCall();

		await expect(
			awaitOverlappingCall(
				() => Promise.reject(new Error("commit failed")),
				parked,
				boundMs,
			),
		).rejects.toThrow("commit failed");

		expect(parked.isReleased()).toBe(true);
	});

	it("propagates a TimeoutError of the call itself instead of blaming the bound", async () => {
		const parked = parkedCall();
		const driverTimeout = new DOMException(
			"statement timed out",
			"TimeoutError",
		);

		await expect(
			awaitOverlappingCall(
				() => Promise.reject(driverTimeout),
				parked,
				boundMs,
			),
		).rejects.toBe(driverTimeout);

		expect(parked.isReleased()).toBe(true);
	});

	it("releases the parked call and propagates a synchronous throw of run", async () => {
		const parked = parkedCall();

		await expect(
			awaitOverlappingCall(
				() => {
					throw new Error("pool exhausted");
				},
				parked,
				boundMs,
			),
		).rejects.toThrow("pool exhausted");

		expect(parked.isReleased()).toBe(true);
	});
});
