import { describe, expect, it } from "vite-plus/test";
import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import {
	createDomainEvent,
	type DomainEvent,
} from "../domain/event/domain-event";
import type { Id } from "../domain/identity/id";
import { createInMemoryStreamPages } from "./in-memory-stream-pages";

type OrderId = Id<"OrderId">;
type OrderRenamed = DomainEvent<"OrderRenamed", { name: string }>;

const stream: AggregateAddress<OrderId> = {
	aggregateType: "Order",
	aggregateId: "order-1" as OrderId,
};

const renamed = (name: string): OrderRenamed =>
	createDomainEvent("OrderRenamed", { name }, stream);

async function collect(
	pages: AsyncIterable<ReadonlyArray<OrderRenamed>>,
): Promise<string[][]> {
	const collected: string[][] = [];
	for await (const page of pages) {
		collected.push(page.map((event) => event.payload.name));
	}
	return collected;
}

describe("createInMemoryStreamPages", () => {
	it("returns the tail as one page on every iteration", async () => {
		const read = createInMemoryStreamPages(stream, {
			fromVersion: 2,
			tail: [renamed("a"), renamed("b")],
			targetVersion: 4,
		});

		expect(await collect(read.pages)).toEqual([["a", "b"]]);
		expect(await collect(read.pages)).toEqual([["a", "b"]]);
		expect(read).toMatchObject({ stream, fromVersion: 2, targetVersion: 4 });
	});

	it("yields no page for an empty tail", async () => {
		const read = createInMemoryStreamPages<OrderRenamed>(stream, {
			fromVersion: 3,
			tail: [],
			targetVersion: 3,
		});

		expect(await collect(read.pages)).toEqual([]);
	});
});
