import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import { InMemoryOutbox } from "../events/outbox";
import type { TransactionScope } from "../repo/scope";
import { withIdempotentCommit } from "./idempotency";
import { InMemoryIdempotencyStore } from "./in-memory-idempotency-store";

interface TestClaimHandle {
	readonly key: string;
	readonly token: string;
	readonly lease?: {
		readonly expiresAt: string;
		readonly renewAfterMs: number;
	};
}

interface TestReconciliationReceipt {
	readonly key: string;
	readonly fingerprint: string;
	readonly token: string;
	readonly expiredAt: string;
}

type TestClaim =
	| { readonly status: "claimed"; readonly claim: TestClaimHandle }
	| { readonly status: "completed"; readonly outcome: unknown }
	| {
			readonly status: "reconciliation-required";
			readonly reconciliation: TestReconciliationReceipt;
	  };

interface MutableClock {
	advance(ms: number): void;
	now(): Date;
}

function mutableClock(initial = "2026-07-14T10:00:00.000Z"): MutableClock {
	let now = new Date(initial).getTime();
	return {
		advance: (ms) => {
			now += ms;
		},
		now: () => new Date(now),
	};
}

function tokenFactory(): () => string {
	let next = 0;
	return () => `claim-${++next}`;
}

function leasedStore(clock: MutableClock) {
	return new InMemoryIdempotencyStore<undefined>({
		clock: clock.now,
		claimTokenFactory: tokenFactory(),
		leaseDurationMs: 100,
		renewAfterMs: 40,
	});
}

function claimedHandle(claim: unknown): TestClaimHandle {
	const candidate = claim as TestClaim;
	if (candidate.status !== "claimed") {
		throw new Error(`Expected claimed, received ${candidate.status}`);
	}
	return candidate.claim;
}

function reconciliationReceipt(claim: unknown): TestReconciliationReceipt {
	const candidate = claim as TestClaim;
	if (candidate.status !== "reconciliation-required") {
		throw new Error(
			`Expected reconciliation-required, received ${candidate.status}`,
		);
	}
	return candidate.reconciliation;
}

function scope(): TransactionScope<undefined> {
	return {
		transactional: <T>(work: (ctx: undefined) => Promise<T>) => work(undefined),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("leased idempotency claims", () => {
	it("reclaims an expired pending lease under a new token and fences the stale owner", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const first = claimedHandle(await store.claim(undefined, "key", "fp"));

		expect(first).toMatchObject({
			key: "key",
			token: expect.any(String),
			lease: { renewAfterMs: 40 },
		});
		clock.advance(101);

		const second = claimedHandle(await store.claim(undefined, "key", "fp"));
		expect(second.token).not.toBe(first.token);
		await expect(
			store.complete(undefined, first, "stale result"),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CLAIM_LOST" });

		await store.complete(undefined, second, "winner");
		await store.confirm(second);
		await expect(store.claim(undefined, "key", "fp")).resolves.toEqual({
			status: "completed",
			outcome: "winner",
		});
	});

	it("renew extends the pending lease without changing ownership", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const claim = claimedHandle(await store.claim(undefined, "key", "fp"));

		clock.advance(40);
		const renewed = await store.renew(claim);
		expect(renewed).toMatchObject({ renewAfterMs: 40 });
		clock.advance(61);
		await expect(store.claim(undefined, "key", "fp")).rejects.toMatchObject({
			code: "IDEMPOTENCY_IN_FLIGHT",
		});

		clock.advance(40);
		const successor = claimedHandle(await store.claim(undefined, "key", "fp"));
		expect(successor.token).not.toBe(claim.token);
	});

	it("stale abandon and confirm cannot alter a successor claim", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const first = claimedHandle(await store.claim(undefined, "key", "fp"));
		clock.advance(101);
		const second = claimedHandle(await store.claim(undefined, "key", "fp"));

		await store.abandon(first);
		await store.confirm(first);
		await expect(store.claim(undefined, "key", "fp")).rejects.toMatchObject({
			code: "IDEMPOTENCY_IN_FLIGHT",
		});

		await store.complete(undefined, second, "winner");
		await store.confirm(second);
		await expect(store.claim(undefined, "key", "fp")).resolves.toEqual({
			status: "completed",
			outcome: "winner",
		});
	});
});

describe("staged idempotency reconciliation", () => {
	it("never reclaims an expired staged outcome without a source-of-truth decision", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const claim = claimedHandle(await store.claim(undefined, "key", "fp"));
		await store.complete(undefined, claim, { orderId: "o-1" });
		clock.advance(101);

		const expired = (await store.claim(undefined, "key", "fp")) as TestClaim;
		expect(expired).toMatchObject({
			status: "reconciliation-required",
			reconciliation: {
				key: "key",
				fingerprint: "fp",
				token: claim.token,
			},
		});
	});

	it("a committed decision confirms the staged outcome for replay", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const claim = claimedHandle(await store.claim(undefined, "key", "fp"));
		await store.complete(undefined, claim, { orderId: "o-1" });
		clock.advance(101);
		const receipt = reconciliationReceipt(
			await store.claim(undefined, "key", "fp"),
		);

		await store.reconcile(receipt, "committed");

		await expect(store.claim(undefined, "key", "fp")).resolves.toEqual({
			status: "completed",
			outcome: { orderId: "o-1" },
		});
	});

	it("a not-committed decision releases the staged outcome for fresh execution", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const claim = claimedHandle(await store.claim(undefined, "key", "fp"));
		await store.complete(undefined, claim, "rolled back");
		clock.advance(101);
		const receipt = reconciliationReceipt(
			await store.claim(undefined, "key", "fp"),
		);

		await store.reconcile(receipt, "not-committed");

		const fresh = claimedHandle(await store.claim(undefined, "key", "fp"));
		expect(fresh.token).not.toBe(claim.token);
	});

	it("a stale reconciliation receipt cannot settle a newer staged owner", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const first = claimedHandle(await store.claim(undefined, "key", "fp"));
		await store.complete(undefined, first, "first");
		clock.advance(101);
		const staleReceipt = reconciliationReceipt(
			await store.claim(undefined, "key", "fp"),
		);
		await store.reconcile(staleReceipt, "not-committed");

		const second = claimedHandle(await store.claim(undefined, "key", "fp"));
		await store.complete(undefined, second, "second");
		clock.advance(101);
		await expect(
			store.reconcile(staleReceipt, "committed"),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CLAIM_LOST" });
	});

	it("rejects an unknown store decision without releasing the staged outcome", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const claim = claimedHandle(await store.claim(undefined, "key", "fp"));
		await store.complete(undefined, claim, "uncertain");
		clock.advance(101);
		const receipt = reconciliationReceipt(
			await store.claim(undefined, "key", "fp"),
		);

		await expect(
			store.reconcile(receipt, "unknown" as never),
		).rejects.toBeInstanceOf(TypeError);
		expect(await store.claim(undefined, "key", "fp")).toMatchObject({
			status: "reconciliation-required",
		});
	});
});

describe("withIdempotentCommit lease orchestration", () => {
	it("renews a leased claim while the transaction remains in flight", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
		const idempotency = new InMemoryIdempotencyStore<undefined>({
			claimTokenFactory: tokenFactory(),
			leaseDurationMs: 100,
			renewAfterMs: 40,
		});
		let entered!: () => void;
		const workEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execution = withIdempotentCommit(
			{
				idempotency,
				outbox: new InMemoryOutbox<AnyDomainEvent>(),
				scope: scope(),
			},
			{ key: "key", fingerprint: "fp" },
			async () => {
				entered();
				await blocked;
				return { result: "done", commits: [] };
			},
		);
		await workEntered;

		await vi.advanceTimersByTimeAsync(250);
		await expect(
			idempotency.claim(undefined, "key", "fp"),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_IN_FLIGHT" });

		release();
		await expect(execution).resolves.toEqual({
			replayed: false,
			result: "done",
		});
	});

	it("rolls back and releases the claim when lease renewal fails", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
		const idempotency = new InMemoryIdempotencyStore<undefined>({
			claimTokenFactory: tokenFactory(),
			leaseDurationMs: 100,
			renewAfterMs: 40,
		});
		const renewalFailure = new Error("lease store unavailable");
		idempotency.renew = async () => {
			throw renewalFailure;
		};
		let entered!: () => void;
		const workEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const execution = withIdempotentCommit(
			{
				idempotency,
				outbox: new InMemoryOutbox<AnyDomainEvent>(),
				scope: scope(),
			},
			{ key: "key", fingerprint: "fp" },
			async () => {
				entered();
				await blocked;
				return { result: "must roll back", commits: [] };
			},
		);
		await workEntered;
		await vi.advanceTimersByTimeAsync(40);
		release();

		await expect(execution).rejects.toBe(renewalFailure);
		await expect(
			idempotency.claim(undefined, "key", "fp"),
		).resolves.toMatchObject({ status: "claimed" });
	});

	it("uses the source of truth to replay a committed staged outcome without re-running work", async () => {
		const clock = mutableClock();
		const idempotency = leasedStore(clock);
		const request = { key: "key", fingerprint: "fp" };
		const claim = claimedHandle(
			await idempotency.claim(undefined, request.key, request.fingerprint),
		);
		await idempotency.complete(undefined, claim, { orderId: "o-1" });
		clock.advance(101);
		let executions = 0;
		const reconciled: TestReconciliationReceipt[] = [];

		const result = await withIdempotentCommit(
			{
				idempotency,
				outbox: new InMemoryOutbox<AnyDomainEvent>(),
				scope: scope(),
				reconcileIdempotency: async (receipt: TestReconciliationReceipt) => {
					reconciled.push(receipt);
					return "committed" as const;
				},
			},
			request,
			async () => {
				executions++;
				return { result: { orderId: "wrong" }, commits: [] };
			},
		);

		expect(result).toEqual({ replayed: true, result: { orderId: "o-1" } });
		expect(executions).toBe(0);
		expect(reconciled).toHaveLength(1);
	});

	it("releases a proven non-commit and exposes the successor token to fresh work", async () => {
		const clock = mutableClock();
		const idempotency = leasedStore(clock);
		const request = { key: "key", fingerprint: "fp" };
		const original = claimedHandle(
			await idempotency.claim(undefined, request.key, request.fingerprint),
		);
		await idempotency.complete(undefined, original, "rolled back");
		clock.advance(101);
		let executionToken: string | undefined;

		const result = await withIdempotentCommit(
			{
				idempotency,
				outbox: new InMemoryOutbox<AnyDomainEvent>(),
				scope: scope(),
				reconcileIdempotency: async () => "not-committed",
			},
			request,
			async (_ctx, _enrollment, execution) => {
				executionToken = execution.claimToken;
				return { result: "fresh", commits: [] };
			},
		);

		expect(result).toEqual({ replayed: false, result: "fresh" });
		expect(executionToken).toEqual(expect.any(String));
		expect(executionToken).not.toBe(original.token);
	});

	it("reports post-commit confirmation failure without rejecting committed work", async () => {
		const clock = mutableClock();
		const idempotency = leasedStore(clock);
		const confirmFailure = new Error("confirm unavailable");
		idempotency.confirm = async () => {
			throw confirmFailure;
		};
		const reported: Array<{
			error: unknown;
			operation: string;
			key: string;
			token: string;
		}> = [];

		const result = await withIdempotentCommit(
			{
				idempotency,
				outbox: new InMemoryOutbox<AnyDomainEvent>(),
				scope: scope(),
				onIdempotencyError: (error, context) => {
					reported.push({ error, ...context });
				},
			},
			{ key: "key", fingerprint: "fp" },
			async () => ({ result: "committed", commits: [] }),
		);

		expect(result).toEqual({ replayed: false, result: "committed" });
		expect(reported).toEqual([
			{
				error: confirmFailure,
				operation: "confirm",
				key: "key",
				token: expect.any(String),
			},
		]);
	});

	it("keeps an unknown staged outcome blocked and fails loud", async () => {
		const clock = mutableClock();
		const idempotency = leasedStore(clock);
		const request = { key: "key", fingerprint: "fp" };
		const claim = claimedHandle(
			await idempotency.claim(undefined, request.key, request.fingerprint),
		);
		await idempotency.complete(undefined, claim, "uncertain");
		clock.advance(101);

		await expect(
			withIdempotentCommit(
				{
					idempotency,
					outbox: new InMemoryOutbox<AnyDomainEvent>(),
					scope: scope(),
					reconcileIdempotency: async () => "unknown" as const,
				},
				request,
				async () => ({ result: "must not run", commits: [] }),
			),
		).rejects.toMatchObject({
			code: "IDEMPOTENCY_RECONCILIATION_REQUIRED",
		});

		expect(await idempotency.claim(undefined, "key", "fp")).toMatchObject({
			status: "reconciliation-required",
		});
	});
});
