import { describe, expect, it } from "vite-plus/test";
import {
	type AnyDomainEvent,
	createDomainEvent,
	InMemoryEventStore,
} from "../../src";

describe("events that createDomainEvent mints", () => {
	it("pass the plain-data rule of the in-memory event store", async () => {
		const store = new InMemoryEventStore<AnyDomainEvent>();
		const stream = { aggregateType: "Order", aggregateId: "o-1" };
		const event = createDomainEvent(
			"OrderPlaced",
			{
				at: new Date(0),
				tags: new Set(["a"]),
				lines: new Map([["sku", 2]]),
				total: { cents: 100 },
			},
			stream,
		);

		await expect(
			store.append(stream, [event], { expectedVersion: 0 }),
		).resolves.toBeUndefined();
	});
});
