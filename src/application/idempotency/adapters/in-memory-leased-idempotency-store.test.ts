import { describe, expect, it } from "vite-plus/test";
import { IdempotencyInFlightError } from "../../../errors/kit-errors";
import { InMemoryTransactionScope } from "../../../persistence/repository/adapters/in-memory-transaction-scope";
import type {
	IdempotencyReconciliation,
	LeasedIdempotencyClaim,
	LeasedIdempotencyClaimHandle,
} from "../idempotency";
import { InMemoryLeasedIdempotencyStore } from "./in-memory-leased-idempotency-store";

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
	return new InMemoryLeasedIdempotencyStore<undefined>({
		clock: clock.now,
		claimTokenFactory: tokenFactory(),
		leaseDurationMs: 100,
		renewAfterMs: 40,
	});
}

function claimedHandle(
	claim: LeasedIdempotencyClaim,
): LeasedIdempotencyClaimHandle {
	if (claim.status !== "claimed") {
		throw new Error(`Expected claimed, received ${claim.status}`);
	}
	return claim.claim;
}

function reconciliationReceipt(
	claim: LeasedIdempotencyClaim,
): IdempotencyReconciliation {
	if (claim.status !== "reconciliation-required") {
		throw new Error(
			`Expected reconciliation-required, received ${claim.status}`,
		);
	}
	return claim.reconciliation;
}

async function claimHandle(
	store: InMemoryLeasedIdempotencyStore<undefined>,
	key: string,
	fingerprint: string,
): Promise<LeasedIdempotencyClaimHandle> {
	return claimedHandle(await store.claim(undefined, key, fingerprint));
}

describe("InMemoryLeasedIdempotencyStore claims", () => {
	it("reclaims an expired pending lease under a new token and fences the stale owner", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const first = await claimHandle(store, "key", "fp");

		expect(first).toMatchObject({
			key: "key",
			token: expect.any(String),
			lease: { renewAfterMs: 40 },
		});
		clock.advance(101);

		const second = await claimHandle(store, "key", "fp");
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
		const claim = await claimHandle(store, "key", "fp");

		clock.advance(40);
		const renewed = await store.renew(claim);
		expect(renewed).toMatchObject({ renewAfterMs: 40 });
		clock.advance(61);
		await expect(store.claim(undefined, "key", "fp")).rejects.toMatchObject({
			code: "IDEMPOTENCY_IN_FLIGHT",
		});

		clock.advance(40);
		const successor = await claimHandle(store, "key", "fp");
		expect(successor.token).not.toBe(claim.token);
	});

	it("stale abandon and confirm cannot alter a successor claim", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const first = await claimHandle(store, "key", "fp");
		clock.advance(101);
		const second = await claimHandle(store, "key", "fp");

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

	it("a staged, unconfirmed outcome is in-flight, never replayed", async () => {
		const store = new InMemoryLeasedIdempotencyStore<undefined>();
		const handle = await claimHandle(store, "k", "fp");
		await store.complete(undefined, handle, "uncommitted");

		await expect(store.claim(undefined, "k", "fp")).rejects.toBeInstanceOf(
			IdempotencyInFlightError,
		);
	});

	it("abandon releases pending and staged entries, never confirmed records", async () => {
		const store = new InMemoryLeasedIdempotencyStore<undefined>();
		const staged = await claimHandle(store, "staged", "fp");
		await store.complete(undefined, staged, "uncommitted");
		await store.abandon(staged);
		await expect(store.claim(undefined, "staged", "fp")).resolves.toMatchObject(
			{ status: "claimed" },
		);

		const confirmed = await claimHandle(store, "confirmed", "fp");
		await store.complete(undefined, confirmed, "done");
		await store.confirm(confirmed);
		await store.abandon(confirmed);
		const claim = await store.claim(undefined, "confirmed", "fp");
		expect(claim).toEqual({ status: "completed", outcome: "done" });
	});

	it("isolates stored outcomes from caller mutation", async () => {
		const store = new InMemoryLeasedIdempotencyStore<undefined>();
		const handle = await claimHandle(store, "k", "fp");
		const outcome = { items: ["a"] };
		await store.complete(undefined, handle, outcome);
		await store.confirm(handle);
		outcome.items.push("b"); // caller mutates after storing

		const claim = await store.claim(undefined, "k", "fp");
		expect(claim).toEqual({
			status: "completed",
			outcome: { items: ["a"] },
		});
		if (claim.status === "completed") {
			(claim.outcome as { items: string[] }).items.push("c");
		}
		const again = await store.claim(undefined, "k", "fp");
		expect(again).toEqual({ status: "completed", outcome: { items: ["a"] } });
	});

	it("throws the wiring error on complete without a claim", async () => {
		const store = new InMemoryLeasedIdempotencyStore<undefined>();

		await expect(
			store.complete(
				undefined,
				{
					key: "k",
					token: "missing",
					lease: { expiresAt: "1970-01-01T00:00:00.000Z", renewAfterMs: 1 },
				},
				"x",
			),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM" });
	});
});

describe("InMemoryLeasedIdempotencyStore in an InMemoryTransactionScope", () => {
	it("returns a claim to pending after a rolled-back complete", async () => {
		const store = new InMemoryLeasedIdempotencyStore<undefined>();
		const scope = new InMemoryTransactionScope([store]);
		const handle = await scope.transactional(() =>
			claimHandle(store, "k", "fp"),
		);

		await scope
			.transactional(async () => {
				await store.complete(undefined, handle, "rolled back");
				throw new Error("work failed");
			})
			.catch(() => {});
		await store.complete(undefined, handle, "committed");
		await store.confirm(handle);

		await expect(store.claim(undefined, "k", "fp")).resolves.toEqual({
			status: "completed",
			outcome: "committed",
		});
	});

	it("leaves the key free after a rolled-back claim", async () => {
		const store = new InMemoryLeasedIdempotencyStore<undefined>();
		const scope = new InMemoryTransactionScope([store]);

		await scope
			.transactional(async () => {
				await claimHandle(store, "k", "fp");
				throw new Error("work failed");
			})
			.catch(() => {});

		await expect(store.claim(undefined, "k", "fp")).resolves.toMatchObject({
			status: "claimed",
		});
	});
});

describe("InMemoryLeasedIdempotencyStore reconciliation", () => {
	it("never reclaims an expired staged outcome without a source-of-truth decision", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const claim = await claimHandle(store, "key", "fp");
		await store.complete(undefined, claim, { orderId: "o-1" });
		clock.advance(101);

		await expect(store.claim(undefined, "key", "fp")).resolves.toMatchObject({
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
		const claim = await claimHandle(store, "key", "fp");
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
		const claim = await claimHandle(store, "key", "fp");
		await store.complete(undefined, claim, "rolled back");
		clock.advance(101);
		const receipt = reconciliationReceipt(
			await store.claim(undefined, "key", "fp"),
		);

		await store.reconcile(receipt, "not-committed");

		const fresh = await claimHandle(store, "key", "fp");
		expect(fresh.token).not.toBe(claim.token);
	});

	it("a stale reconciliation receipt cannot settle a newer staged owner", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const first = await claimHandle(store, "key", "fp");
		await store.complete(undefined, first, "first");
		clock.advance(101);
		const staleReceipt = reconciliationReceipt(
			await store.claim(undefined, "key", "fp"),
		);
		await store.reconcile(staleReceipt, "not-committed");

		const second = await claimHandle(store, "key", "fp");
		await store.complete(undefined, second, "second");
		clock.advance(101);
		await expect(
			store.reconcile(staleReceipt, "committed"),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CLAIM_LOST" });
	});

	it("rejects an unknown store decision without releasing the staged outcome", async () => {
		const clock = mutableClock();
		const store = leasedStore(clock);
		const claim = await claimHandle(store, "key", "fp");
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

describe("InMemoryLeasedIdempotencyStore capacity", () => {
	it("rejects a new key at capacity while preserving replay of existing keys", async () => {
		const store = new InMemoryLeasedIdempotencyStore<undefined>({
			maxEntries: 1,
		});
		const existing = await claimHandle(store, "existing", "fp");
		await store.complete(undefined, existing, { orderId: "o-1" });
		await store.confirm(existing);

		await expect(store.claim(undefined, "new", "fp-new")).rejects.toMatchObject(
			{
				code: "IN_MEMORY_CAPACITY_EXCEEDED",
				store: "InMemoryLeasedIdempotencyStore",
				resource: "entries",
				limit: 1,
				current: 1,
				attempted: 1,
			},
		);
		await expect(store.claim(undefined, "existing", "fp")).resolves.toEqual({
			status: "completed",
			outcome: { orderId: "o-1" },
		});
		expect(store.size).toBe(1);
	});

	it("releases capacity when an unconfirmed claim is abandoned", async () => {
		const store = new InMemoryLeasedIdempotencyStore<undefined>({
			maxEntries: 1,
		});
		const first = await claimHandle(store, "first", "fp-1");
		await store.abandon(first);

		await expect(
			store.claim(undefined, "second", "fp-2"),
		).resolves.toMatchObject({ status: "claimed" });
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid maxEntries capacity %s",
		(maxEntries) => {
			expect(
				() => new InMemoryLeasedIdempotencyStore({ maxEntries }),
			).toThrowError(RangeError);
		},
	);
});
