import { describe, expect, it } from "vite-plus/test";
import type { AggregateSnapshot, Version } from "../aggregate/aggregate";
import type { Id } from "../core/id";
import { InMemorySnapshotStore } from "./in-memory-snapshot-store";

interface TestState {
	readonly label: string;
}

const id = (value: string): Id<string> => value as Id<string>;

function snapshot(
	label: string,
	version: number,
): AggregateSnapshot<TestState> {
	return {
		state: { label },
		version: version as Version,
		snapshotAt: new Date("2026-07-13T10:00:00.000Z"),
	};
}

describe("InMemorySnapshotStore aggregate addresses", () => {
	it("uses one value-address object and cannot alias delimiter-like values", async () => {
		const store = new InMemorySnapshotStore<TestState>();
		const first = {
			aggregateType: "Sales\u0000Order",
			aggregateId: id("shared"),
		};
		const second = {
			aggregateType: "Sales",
			aggregateId: id("Order\u0000shared"),
		};

		await store.save(first, snapshot("first", 1));
		await store.save(second, snapshot("second", 2));

		await expect(store.load({ ...first })).resolves.toMatchObject({
			state: { label: "first" },
			version: 1,
		});
		await expect(store.load({ ...second })).resolves.toMatchObject({
			state: { label: "second" },
			version: 2,
		});
	});
});

describe("InMemorySnapshotStore retention", () => {
	it("evicts the least recently used snapshot at maxEntries", async () => {
		const store = new InMemorySnapshotStore<TestState>({ maxEntries: 2 });
		const first = { aggregateType: "Order", aggregateId: id("o-1") };
		const second = { aggregateType: "Order", aggregateId: id("o-2") };
		const third = { aggregateType: "Order", aggregateId: id("o-3") };
		await store.save(first, snapshot("first", 1));
		await store.save(second, snapshot("second", 1));

		await store.load(first);
		await store.save(third, snapshot("third", 1));

		await expect(store.load(first)).resolves.toMatchObject({
			state: { label: "first" },
		});
		await expect(store.load(second)).resolves.toBeUndefined();
		await expect(store.load(third)).resolves.toMatchObject({
			state: { label: "third" },
		});
	});

	it("expires snapshots at the TTL boundary without extending TTL on load", async () => {
		let nowMs = Date.parse("2026-07-15T08:00:00.000Z");
		const store = new InMemorySnapshotStore<TestState>({
			ttlMs: 1_000,
			clock: () => new Date(nowMs),
		});
		const order = { aggregateType: "Order", aggregateId: id("o-1") };
		await store.save(order, snapshot("first", 1));

		nowMs += 999;
		await expect(store.load(order)).resolves.toMatchObject({
			state: { label: "first" },
		});
		nowMs += 1;
		await expect(store.load(order)).resolves.toBeUndefined();
	});

	it("replacing a snapshot refreshes its TTL and LRU position", async () => {
		let nowMs = Date.parse("2026-07-15T08:00:00.000Z");
		const store = new InMemorySnapshotStore<TestState>({
			maxEntries: 1,
			ttlMs: 1_000,
			clock: () => new Date(nowMs),
		});
		const order = { aggregateType: "Order", aggregateId: id("o-1") };
		await store.save(order, snapshot("first", 1));
		nowMs += 900;
		await store.save(order, snapshot("second", 2));
		nowMs += 900;

		await expect(store.load(order)).resolves.toMatchObject({
			state: { label: "second" },
			version: 2,
		});
	});

	it.each([
		["maxEntries", 0],
		["maxEntries", -1],
		["maxEntries", 1.5],
		["maxEntries", Number.MAX_SAFE_INTEGER + 1],
		["ttlMs", 0],
		["ttlMs", -1],
		["ttlMs", 1.5],
		["ttlMs", Number.MAX_SAFE_INTEGER + 1],
	] as const)("rejects invalid %s option %s", (name, value) => {
		expect(() => new InMemorySnapshotStore({ [name]: value })).toThrow(
			RangeError,
		);
	});

	it("rejects an invalid injected clock result before storing", async () => {
		const store = new InMemorySnapshotStore<TestState>({
			ttlMs: 1_000,
			clock: () => new Date(Number.NaN),
		});

		await expect(
			store.save(
				{ aggregateType: "Order", aggregateId: id("o-1") },
				snapshot("first", 1),
			),
		).rejects.toThrow(TypeError);
	});
});
