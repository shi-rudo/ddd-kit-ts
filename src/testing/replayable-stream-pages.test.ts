import { describe, expect, it } from "vite-plus/test";
import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import {
	createDomainEvent,
	type DomainEvent,
} from "../domain/event/domain-event";
import type { Id } from "../domain/identity/id";
import { createReplayableStreamPages } from "./replayable-stream-pages";

type OrderId = Id<"OrderId">;
type OrderRenamed = DomainEvent<"OrderRenamed", { name: string }>;

const stream: AggregateAddress<OrderId> = {
	aggregateType: "Order",
	aggregateId: "order-1" as OrderId,
};

const renamed = (name: string): OrderRenamed =>
	createDomainEvent("OrderRenamed", { name }, stream);

async function collectPages(
	pages: AsyncIterable<ReadonlyArray<OrderRenamed>>,
): Promise<string[][]> {
	const collected: string[][] = [];
	for await (const page of pages) {
		collected.push(page.map((event) => event.payload.name));
	}
	return collected;
}

describe("createReplayableStreamPages", () => {
	it("returns the tail as one page on every iteration", async () => {
		const read = createReplayableStreamPages(stream, {
			fromVersion: 2,
			tail: [renamed("a"), renamed("b")],
			targetVersion: 4,
		});

		expect(await collectPages(read.pages)).toEqual([["a", "b"]]);
		expect(await collectPages(read.pages)).toEqual([["a", "b"]]);
	});

	it("carries the stream and the window unchanged", () => {
		const read = createReplayableStreamPages(stream, {
			fromVersion: 2,
			tail: [renamed("a")],
			targetVersion: 3,
		});

		expect(read).toMatchObject({ stream, fromVersion: 2, targetVersion: 3 });
	});

	it("keeps its page when the caller mutates the tail afterwards", async () => {
		const tail = [renamed("a")];
		const read = createReplayableStreamPages(stream, {
			fromVersion: 0,
			tail,
			targetVersion: 1,
		});
		tail.push(renamed("b"));

		expect(await collectPages(read.pages)).toEqual([["a"]]);
	});

	it("yields no page for an empty tail", async () => {
		const read = createReplayableStreamPages<OrderRenamed>(stream, {
			fromVersion: 3,
			tail: [],
			targetVersion: 3,
		});

		expect(await collectPages(read.pages)).toEqual([]);
	});
});
