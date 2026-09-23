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

	it("slices the tail into pages of at most the limit on every iteration", async () => {
		const read = createReplayableStreamPages(stream, {
			fromVersion: 0,
			tail: [renamed("a"), renamed("b"), renamed("c")],
			targetVersion: 3,
			limit: 2,
		});

		expect(await collectPages(read.pages)).toEqual([["a", "b"], ["c"]]);
		expect(await collectPages(read.pages)).toEqual([["a", "b"], ["c"]]);
	});

	it("rejects a limit that is not a positive safe integer", () => {
		expect(() =>
			createReplayableStreamPages(stream, {
				fromVersion: 0,
				tail: [renamed("a")],
				targetVersion: 1,
				limit: 0,
			}),
		).toThrow(
			/createReplayableStreamPages: limit must be a positive safe integer/,
		);
	});

	it("hands out frozen events, so a consumer that changes one fails at the write", async () => {
		const read = createReplayableStreamPages(stream, {
			fromVersion: 0,
			tail: [{ ...renamed("a"), payload: { name: "a" } }],
			targetVersion: 1,
		});

		for await (const page of read.pages) {
			const event = page[0] as OrderRenamed;
			expect(() => {
				(event.payload as { name: string }).name = "changed";
			}).toThrow(TypeError);
		}
	});

	it("leaves the events of the caller unfrozen", () => {
		const event: OrderRenamed = { ...renamed("a"), payload: { name: "a" } };

		createReplayableStreamPages(stream, {
			fromVersion: 0,
			tail: [event],
			targetVersion: 1,
		});

		expect(Object.isFrozen(event)).toBe(false);
		expect(Object.isFrozen(event.payload)).toBe(false);
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
