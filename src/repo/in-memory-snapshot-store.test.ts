import { describe, expect, it } from "vitest";
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
