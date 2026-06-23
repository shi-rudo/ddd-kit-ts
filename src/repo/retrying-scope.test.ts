import { describe, expect, it, vi } from "vitest";
import { ConcurrencyConflictError, EventHarvestError } from "../core/errors";
import type { TransactionScope } from "./scope";
import {
	computeBackoffDelay,
	RetryingTransactionScope,
} from "./retrying-scope";

/** A scope whose callback runs immediately (no real transaction). */
function passthroughScope(): TransactionScope<undefined> {
	return {
		transactional: <T>(fn: (ctx: undefined) => Promise<T>) => fn(undefined),
	};
}

/** A scope that rejects the first `failures` attempts, then succeeds. */
function flakyScope(
	failures: number,
	error: () => unknown,
): TransactionScope<undefined> & { attempts: number } {
	const scope = {
		attempts: 0,
		transactional: async <T>(fn: (ctx: undefined) => Promise<T>): Promise<T> => {
			scope.attempts += 1;
			if (scope.attempts <= failures) throw error();
			return fn(undefined);
		},
	};
	return scope;
}

/** No-wait sleep so tests never touch real timers. */
const instantSleep = async () => {};

const conflict = () => new ConcurrencyConflictError({ aggregateType: "Order", aggregateId: "o-1", expectedVersion: 1, actualVersion: 2 });

describe("computeBackoffDelay", () => {
	const opts = (random: () => number) => ({
		baseDelayMs: 50,
		maxDelayMs: 1000,
		random,
	});

	it("grows exponentially (base * 2^(attempt-1)) at the midpoint multiplier", () => {
		// random()=0.5 -> jitter multiplier 1.0 -> exact base*2^(n-1)
		const mid = opts(() => 0.5);
		expect(computeBackoffDelay(1, mid)).toBe(50);
		expect(computeBackoffDelay(2, mid)).toBe(100);
		expect(computeBackoffDelay(3, mid)).toBe(200);
		expect(computeBackoffDelay(4, mid)).toBe(400);
	});

	it("applies a +/-20% jitter band", () => {
		expect(computeBackoffDelay(2, opts(() => 0))).toBe(80); // 100 * 0.8
		expect(computeBackoffDelay(2, opts(() => 0.999999))).toBe(120); // ~100 * 1.2
	});

	it("never exceeds maxDelayMs even after jitter", () => {
		// attempt 10 -> 50*2^9 = 25600, capped to 1000, *1.2 -> clamped to 1000
		expect(computeBackoffDelay(10, opts(() => 0.999999))).toBe(1000);
	});
});

describe("RetryingTransactionScope", () => {
	it("returns the result without retrying when the inner scope succeeds", async () => {
		const inner = flakyScope(0, conflict);
		const scope = new RetryingTransactionScope(inner, { sleep: instantSleep });

		const result = await scope.transactional(async () => "ok");

		expect(result).toBe("ok");
		expect(inner.attempts).toBe(1);
	});

	it("retries a retryable error and then succeeds", async () => {
		const inner = flakyScope(1, conflict);
		const onRetry = vi.fn();
		const scope = new RetryingTransactionScope(inner, {
			sleep: instantSleep,
			onRetry,
		});

		const result = await scope.transactional(async () => "ok");

		expect(result).toBe("ok");
		expect(inner.attempts).toBe(2);
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
	});

	it("does NOT retry a non-retryable error and surfaces it unchanged", async () => {
		const harvestError = new EventHarvestError("missing aggregateId");
		const inner = flakyScope(1, () => harvestError);
		const scope = new RetryingTransactionScope(inner, { sleep: instantSleep });

		const rejection = await scope
			.transactional(async () => "unreachable")
			.catch((e) => e);

		expect(rejection).toBe(harvestError);
		expect(inner.attempts).toBe(1);
	});

	it("surfaces the last error unchanged after exhausting maxAttempts", async () => {
		const inner = flakyScope(99, conflict); // always fails
		const scope = new RetryingTransactionScope(inner, {
			maxAttempts: 3,
			sleep: instantSleep,
		});

		const rejection = await scope
			.transactional(async () => "unreachable")
			.catch((e) => e);

		expect(rejection).toBeInstanceOf(ConcurrencyConflictError);
		expect(inner.attempts).toBe(3);
	});

	it("rejects with the signal reason before the first attempt when already aborted", async () => {
		const inner = flakyScope(0, conflict);
		const scope = new RetryingTransactionScope(inner, { sleep: instantSleep });
		const ac = new AbortController();
		ac.abort(new Error("client gave up"));

		await expect(
			scope.transactional(async () => "ok", { signal: ac.signal }),
		).rejects.toThrow("client gave up");
		expect(inner.attempts).toBe(0);
	});

	it("stops retrying and rejects when the signal aborts during backoff", async () => {
		const inner = flakyScope(99, conflict);
		const ac = new AbortController();
		// A sleep that aborts mid-wait, simulating a deadline firing.
		const sleep = async () => {
			ac.abort(new Error("deadline"));
			throw ac.signal.reason;
		};
		const scope = new RetryingTransactionScope(inner, { sleep });

		await expect(
			scope.transactional(async () => "ok", { signal: ac.signal }),
		).rejects.toThrow("deadline");
		expect(inner.attempts).toBe(1); // failed once, aborted during backoff
	});

	it("forwards the transactional options (signal) to the inner scope", async () => {
		let received: AbortSignal | undefined;
		const inner: TransactionScope<undefined> = {
			transactional: async <T>(
				fn: (ctx: undefined) => Promise<T>,
				opts?: { signal?: AbortSignal },
			) => {
				received = opts?.signal;
				return fn(undefined);
			},
		};
		const scope = new RetryingTransactionScope(inner, { sleep: instantSleep });
		const ac = new AbortController();

		await scope.transactional(async () => "ok", { signal: ac.signal });

		expect(received).toBe(ac.signal);
	});

	it("rejects an invalid maxAttempts at construction instead of silently dropping the write", () => {
		const inner = passthroughScope();
		expect(() => new RetryingTransactionScope(inner, { maxAttempts: 0 })).toThrow(
			/maxAttempts/,
		);
		expect(
			() => new RetryingTransactionScope(inner, { maxAttempts: -1 }),
		).toThrow(/maxAttempts/);
		expect(
			() => new RetryingTransactionScope(inner, { maxAttempts: 2.5 }),
		).toThrow(/maxAttempts/);
	});

	it("rejects negative or non-finite delays at construction", () => {
		const inner = passthroughScope();
		expect(
			() => new RetryingTransactionScope(inner, { baseDelayMs: -1 }),
		).toThrow(/baseDelayMs/);
		expect(
			() => new RetryingTransactionScope(inner, { maxDelayMs: Number.NaN }),
		).toThrow(/maxDelayMs/);
	});

	it("honors a custom isRetryable predicate", async () => {
		class FlakyDriverError extends Error {}
		const inner = flakyScope(1, () => new FlakyDriverError("deadlock 1213"));
		const scope = new RetryingTransactionScope(inner, {
			sleep: instantSleep,
			isRetryable: (e) => e instanceof FlakyDriverError,
		});

		const result = await scope.transactional(async () => "ok");

		expect(result).toBe("ok");
		expect(inner.attempts).toBe(2);
	});
});
