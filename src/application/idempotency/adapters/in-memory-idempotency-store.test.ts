import { describe, expect, it } from "vite-plus/test";
import {
	IdempotencyInFlightError,
	IdempotencyKeyReuseError,
} from "../../../errors/kit-errors";
import { InMemoryTransactionScope } from "../../../persistence/repository/adapters/in-memory-transaction-scope";
import type { IdempotencyClaim, IdempotencyClaimHandle } from "../idempotency";
import { InMemoryIdempotencyStore } from "./in-memory-idempotency-store";

function claimedHandle(claim: IdempotencyClaim): IdempotencyClaimHandle {
	if (claim.status !== "claimed") {
		throw new Error(`Expected claimed, received ${claim.status}`);
	}
	return claim.claim;
}

function registeredStore(options?: { maxEntries?: number }) {
	const store = new InMemoryIdempotencyStore<undefined>(options);
	return { store, scope: new InMemoryTransactionScope([store]) };
}

describe("InMemoryIdempotencyStore", () => {
	it("makes a committed outcome replayable", async () => {
		const { store, scope } = registeredStore();
		await scope.transactional(async () => {
			const claim = claimedHandle(await store.claim(undefined, "k", "fp"));
			await store.complete(undefined, claim, { orderId: "o-1" });
		});

		await expect(
			scope.transactional(() => store.claim(undefined, "k", "fp")),
		).resolves.toEqual({ status: "completed", outcome: { orderId: "o-1" } });
	});

	it("leaves the key free after a rolled-back claim and complete", async () => {
		const { store, scope } = registeredStore();
		await scope
			.transactional(async () => {
				const claim = claimedHandle(await store.claim(undefined, "k", "fp"));
				await store.complete(undefined, claim, "rolled back");
				throw new Error("work failed");
			})
			.catch(() => {});

		expect(store.size).toBe(0);
		await expect(
			scope.transactional(() => store.claim(undefined, "k", "fp")),
		).resolves.toMatchObject({ status: "claimed" });
	});

	it("gives a later claim a new token after a rolled-back claim", async () => {
		const { store, scope } = registeredStore();
		let rolledBack: IdempotencyClaimHandle | undefined;
		await scope
			.transactional(async () => {
				rolledBack = claimedHandle(await store.claim(undefined, "k", "fp"));
				throw new Error("work failed");
			})
			.catch(() => {});

		const later = await scope.transactional(async () =>
			claimedHandle(await store.claim(undefined, "k", "fp")),
		);

		expect(later.token).not.toBe(rolledBack?.token);
	});

	it("throws IdempotencyInFlightError for a second claim of a pending key in one transaction", async () => {
		const { store, scope } = registeredStore();

		await expect(
			scope.transactional(async () => {
				await store.claim(undefined, "k", "fp");
				return store.claim(undefined, "k", "fp");
			}),
		).rejects.toBeInstanceOf(IdempotencyInFlightError);
	});

	it("rejects the same key with a different fingerprint", async () => {
		const { store, scope } = registeredStore();
		await scope.transactional(async () => {
			const claim = claimedHandle(await store.claim(undefined, "k", "fp"));
			await store.complete(undefined, claim, "done");
		});

		await expect(
			scope.transactional(() => store.claim(undefined, "k", "fp-OTHER")),
		).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
	});

	it("isolates stored outcomes from caller mutation", async () => {
		const { store, scope } = registeredStore();
		const outcome = { items: ["a"] };
		await scope.transactional(async () => {
			const claim = claimedHandle(await store.claim(undefined, "k", "fp"));
			await store.complete(undefined, claim, outcome);
		});
		outcome.items.push("b"); // caller mutates after storing

		const claim = await scope.transactional(() =>
			store.claim(undefined, "k", "fp"),
		);
		expect(claim).toEqual({ status: "completed", outcome: { items: ["a"] } });
		if (claim.status === "completed") {
			(claim.outcome as { items: string[] }).items.push("c");
		}
		await expect(
			scope.transactional(() => store.claim(undefined, "k", "fp")),
		).resolves.toEqual({ status: "completed", outcome: { items: ["a"] } });
	});

	it("throws the wiring error on complete without a claim", async () => {
		const { store, scope } = registeredStore();

		await expect(
			scope.transactional(() =>
				store.complete(undefined, { key: "k", token: "missing" }, "x"),
			),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_COMPLETED_WITHOUT_CLAIM" });
	});

	it("throws a TypeError for a claim outside a transaction", async () => {
		const store = new InMemoryIdempotencyStore<undefined>();

		await expect(store.claim(undefined, "k", "fp")).rejects.toThrow(
			"InMemoryIdempotencyStore.claim() ran outside a transaction",
		);
		expect(store.size).toBe(0);
	});

	it("throws a TypeError for a complete outside a transaction", async () => {
		const { store, scope } = registeredStore();
		const claim = await scope.transactional(async () =>
			claimedHandle(await store.claim(undefined, "k", "fp")),
		);

		await expect(store.complete(undefined, claim, "x")).rejects.toThrow(
			"InMemoryIdempotencyStore.complete() ran outside a transaction",
		);
	});

	it("rejects a new key at capacity while preserving replay of existing keys", async () => {
		const { store, scope } = registeredStore({ maxEntries: 1 });
		await scope.transactional(async () => {
			const claim = claimedHandle(
				await store.claim(undefined, "existing", "fp"),
			);
			await store.complete(undefined, claim, { orderId: "o-1" });
		});

		await expect(
			scope.transactional(() => store.claim(undefined, "new", "fp-new")),
		).rejects.toMatchObject({
			code: "IN_MEMORY_CAPACITY_EXCEEDED",
			store: "InMemoryIdempotencyStore",
			resource: "entries",
			limit: 1,
			current: 1,
			attempted: 1,
		});
		await expect(
			scope.transactional(() => store.claim(undefined, "existing", "fp")),
		).resolves.toEqual({ status: "completed", outcome: { orderId: "o-1" } });
	});

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid maxEntries capacity %s",
		(maxEntries) => {
			expect(() => new InMemoryIdempotencyStore({ maxEntries })).toThrowError(
				RangeError,
			);
		},
	);
});
