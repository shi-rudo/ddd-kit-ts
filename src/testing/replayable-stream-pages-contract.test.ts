import { describe, expect, it } from "vite-plus/test";
import {
	type AggregateIdentity,
	encodeAggregateIdentity,
} from "../domain/aggregate/aggregate-identity";
import {
	createDomainEvent,
	type DomainEvent,
} from "../domain/event/domain-event";
import { InMemoryEventStore } from "../persistence/event-store/adapters/in-memory-event-store";
import {
	pinTargetVersion,
	readStreamPages,
} from "../persistence/event-store/read-stream-pages";
import type { ReplayableStreamPages } from "../persistence/event-store/reconstitute-from-stream-pages";
import {
	createReplayableStreamPagesContractTests,
	type ReplayableStreamPagesContractHarness,
	type ReplayableStreamPagesContractWindow,
} from "./index";

type StepRecorded = DomainEvent<"StepRecorded", { sequence: number }>;

function harnessOver(
	createEnvironment: ReplayableStreamPagesContractHarness<StepRecorded>["createEnvironment"],
): ReplayableStreamPagesContractHarness<StepRecorded> {
	let streams = 0;
	return {
		createEnvironment,
		createStream: () => {
			streams += 1;
			return { aggregateType: "Step", aggregateId: `step-${streams}` };
		},
		createEvent: (stream, sequence) =>
			createDomainEvent("StepRecorded", { sequence }, stream),
	};
}

/** Pages over stored rows on its own, as the guide appendix shows. */
function readOnItsOwn(
	rows: Map<string, StepRecorded[]>,
	stream: AggregateIdentity,
	window: ReplayableStreamPagesContractWindow,
): ReplayableStreamPages<StepRecorded> | undefined {
	const key = encodeAggregateIdentity(stream);
	const head = rows.get(key)?.length ?? 0;
	if (head === 0) return undefined;
	const pinned = pinTargetVersion({
		fromVersion: window.fromVersion,
		toVersion: window.toVersion,
		lastVersion: head,
	});
	if (!pinned.reachable) return undefined;
	const { targetVersion } = pinned;
	return {
		stream,
		fromVersion: window.fromVersion,
		targetVersion,
		pages: {
			async *[Symbol.asyncIterator]() {
				let cursor = window.fromVersion;
				while (cursor < targetVersion) {
					const end = Math.min(cursor + window.limit, targetVersion);
					const page = (rows.get(key) ?? []).slice(cursor, end);
					if (page.length === 0) {
						throw new Error("the stream lost rows during the read");
					}
					yield page;
					cursor += page.length;
				}
			},
		},
	};
}

describe("replayable stream pages contract: readStreamPages", () => {
	const contractTests = createReplayableStreamPagesContractTests(
		harnessOver(async () => {
			const store = new InMemoryEventStore<StepRecorded>();
			return {
				append: async (stream, events) => {
					const head = await store.readStream(stream, { limit: 1 });
					await store.append(stream, events, {
						expectedVersion: head.lastVersion,
					});
				},
				read: async (stream, window) => {
					const read = await readStreamPages(store, stream, window);
					return read.reachable ? read : undefined;
				},
			};
		}),
	);

	it("lists every contract test by name", () => {
		expect(contractTests.map(({ name }) => name)).toEqual([
			"full read: the pages hold every event through the head in append order",
			"catch-up read: the pages start after fromVersion",
			"point-in-time read: toVersion is the target version and the pages end there",
			"empty window: a read at the head yields no page",
			"re-iteration: every iteration yields the same prefix",
			"target as upper bound: an append during the iteration stays out of the pages",
			"no replayable read: an absent stream and a window outside the stream",
		]);
	});

	for (const test of contractTests) {
		it(test.name, test.run);
	}
});

describe("replayable stream pages contract: an adapter that pages on its own", () => {
	const contractTests = createReplayableStreamPagesContractTests(
		harnessOver(async () => {
			const rows = new Map<string, StepRecorded[]>();
			return {
				append: async (stream, events) => {
					const key = encodeAggregateIdentity(stream);
					rows.set(key, [...(rows.get(key) ?? []), ...events]);
				},
				read: async (stream, window) => readOnItsOwn(rows, stream, window),
			};
		}),
	);

	for (const test of contractTests) {
		it(test.name, test.run);
	}
});
