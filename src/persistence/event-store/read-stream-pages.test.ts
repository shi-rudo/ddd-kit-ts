import { describe, expect, it } from "vite-plus/test";
import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import {
	type AnyDomainEvent,
	createDomainEvent,
	type DomainEvent,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import { InvalidEventStreamPageError } from "../../errors/kit-errors";
import { InMemoryEventStore } from "./adapters/in-memory-event-store";
import type {
	EventStore,
	EventStoreAppendOptions,
	EventStreamReader,
	ReadStreamOptions,
	StreamReadResult,
} from "./event-store";
import {
	pinTargetVersion,
	type ReachableStreamPages,
	type ReadStreamPagesOptions,
	readStreamPages,
} from "./read-stream-pages";

type CounterId = Id<"CounterId">;
type Counted = DomainEvent<"Counted", { by: number }>;

const stream: AggregateAddress<CounterId> = {
	aggregateType: "Counter",
	aggregateId: "counter-1" as CounterId,
};

function counted(by: number): Counted {
	return createDomainEvent("Counted", { by }, stream);
}

/** Counts reads so a test can prove when the iteration stopped. */
class CountingEventStore<Evt extends AnyDomainEvent>
	implements EventStore<Evt>
{
	reads = 0;
	constructor(private readonly inner: EventStore<Evt>) {}

	append(
		address: AggregateAddress,
		events: ReadonlyArray<Evt>,
		options: EventStoreAppendOptions,
	): Promise<void> {
		return this.inner.append(address, events, options);
	}

	readStream(
		address: AggregateAddress,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<Evt>> {
		this.reads += 1;
		return this.inner.readStream(address, options);
	}
}

/** Answers each read with the next scripted page: an adapter under test control. */
function scriptedReader(
	...pages: ReadonlyArray<StreamReadResult<Counted>>
): EventStreamReader<Counted> {
	let next = 0;
	return {
		readStream: async () => {
			const page = pages[next];
			next += 1;
			if (page === undefined) throw new Error("no scripted page is left");
			return page;
		},
	};
}

/** Returns at most one event per page: a store that pages shorter than the limit. */
class ShortPageReader implements EventStreamReader<Counted> {
	constructor(private readonly inner: CountingEventStore<Counted>) {}

	get reads(): number {
		return this.inner.reads;
	}

	async readStream(
		address: AggregateAddress,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<Counted>> {
		const page = await this.inner.readStream(address, options);
		if (!page.exists) return page;
		return { ...page, events: page.events.slice(0, 1) };
	}
}

async function seededStore(
	events: ReadonlyArray<Counted>,
): Promise<CountingEventStore<Counted>> {
	const store = new CountingEventStore(new InMemoryEventStore<Counted>());
	await store.append(stream, events, { expectedVersion: 0 });
	return store;
}

const countedUpTo = (count: number): Counted[] =>
	Array.from({ length: count }, (_, index) => counted(index + 1));

async function collectPages<Evt>(
	pages: AsyncIterable<ReadonlyArray<Evt>>,
): Promise<Evt[][]> {
	const collected: Evt[][] = [];
	for await (const page of pages) collected.push([...page]);
	return collected;
}

const eventIds = (events: ReadonlyArray<AnyDomainEvent>): string[] =>
	events.map((event) => event.eventId);

async function readReachable(
	store: EventStreamReader<Counted>,
	options: ReadStreamPagesOptions,
): Promise<ReachableStreamPages<Counted>> {
	const read = await readStreamPages(store, stream, options);
	if (!read.reachable) throw new Error("the seeded window must be reachable");
	return read;
}

describe("readStreamPages", () => {
	it("reports an absent stream from the first page and reads no other", async () => {
		const store = new CountingEventStore(new InMemoryEventStore<Counted>());

		const read = await readStreamPages(store, stream, { limit: 2 });

		expect(read).toEqual({ exists: false, reachable: false });
		expect(store.reads).toBe(1);
	});

	it("pins the head on the first page and walks the pages in append order within the limit", async () => {
		const history = countedUpTo(5);
		const store = await seededStore(history);

		const read = await readReachable(store, { limit: 2 });
		const pages = await collectPages(read.pages);

		expect(read).toMatchObject({
			exists: true,
			reachable: true,
			fromVersion: 0,
		});
		expect(read.targetVersion).toBe(5);
		expect(read.stream).toEqual(stream);
		expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
		expect(eventIds(pages.flat())).toEqual(eventIds(history));
		expect(store.reads).toBe(3);
	});

	it("stops at the pinned head when another writer appends during the iteration", async () => {
		const history = countedUpTo(5);
		const store = await seededStore(history);
		const read = await readReachable(store, { limit: 2 });

		const collected: Counted[] = [];
		for await (const page of read.pages) {
			collected.push(...page);
			if (collected.length === 2) {
				await store.append(stream, [counted(6)], { expectedVersion: 5 });
			}
		}

		expect(read.targetVersion).toBe(5);
		expect(eventIds(collected)).toEqual(eventIds(history));
		const afterwards = await store.readStream(stream, { limit: 10 });
		expect(afterwards.lastVersion).toBe(6);
	});

	it("reads the continuation pages again on a second iteration", async () => {
		const history = countedUpTo(5);
		const store = await seededStore(history);
		const read = await readReachable(store, { limit: 2 });

		const firstPass = await collectPages(read.pages);
		const secondPass = await collectPages(read.pages);

		expect(eventIds(firstPass.flat())).toEqual(eventIds(history));
		expect(eventIds(secondPass.flat())).toEqual(eventIds(history));
		expect(store.reads).toBe(5);
	});

	it("yields no page for an empty window and keeps the pinned head", async () => {
		const store = await seededStore(countedUpTo(3));

		const read = await readReachable(store, {
			fromVersion: 3,
			limit: 2,
		});

		expect(read.targetVersion).toBe(3);
		expect(await collectPages(read.pages)).toEqual([]);
	});

	it("pins toVersion as the target and stops there below the head", async () => {
		const history = countedUpTo(5);
		const store = await seededStore(history);

		const read = await readReachable(store, {
			toVersion: 3,
			limit: 2,
		});
		const pages = await collectPages(read.pages);

		expect(read.targetVersion).toBe(3);
		expect(eventIds(pages.flat())).toEqual(eventIds(history.slice(0, 3)));
	});

	it("bounds the first page to toVersion when the limit exceeds it", async () => {
		const history = countedUpTo(5);
		const store = await seededStore(history);

		const read = await readReachable(store, { toVersion: 3, limit: 10 });
		const pages = await collectPages(read.pages);

		expect(eventIds(pages.flat())).toEqual(eventIds(history.slice(0, 3)));
		expect(store.reads).toBe(1);
	});

	it("advances the cursor by the events a short page returned", async () => {
		const history = countedUpTo(5);
		const store = new ShortPageReader(await seededStore(history));

		const read = await readReachable(store, { limit: 2 });
		const pages = await collectPages(read.pages);

		expect(pages.map((page) => page.length)).toEqual([1, 1, 1, 1, 1]);
		expect(eventIds(pages.flat())).toEqual(eventIds(history));
		expect(store.reads).toBe(5);
	});

	it("reads through an object that offers readStream only", async () => {
		const history = countedUpTo(3);
		const store = await seededStore(history);
		const reader: EventStreamReader<Counted> = {
			readStream: (address, options) => store.readStream(address, options),
		};

		const read = await readReachable(reader, { limit: 2 });
		const pages = await collectPages(read.pages);

		expect(eventIds(pages.flat())).toEqual(eventIds(history));
	});

	it("rejects with the abort reason before the first read when the signal is aborted", async () => {
		const store = await seededStore(countedUpTo(3));
		const controller = new AbortController();
		controller.abort();

		await expect(
			readStreamPages(store, stream, { limit: 2, signal: controller.signal }),
		).rejects.toBe(controller.signal.reason);
		expect(store.reads).toBe(0);
	});

	it("rejects with an Error when an aborted signal carries no reason", async () => {
		const store = await seededStore(countedUpTo(3));
		const signalWithoutReason = {
			aborted: true,
			reason: undefined,
		} as unknown as AbortSignal;

		const rejection = await readStreamPages(store, stream, {
			limit: 2,
			signal: signalWithoutReason,
		}).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(Error);
		expect(rejection).toMatchObject({ message: "readStreamPages aborted" });
		expect(store.reads).toBe(0);
	});

	it("stops paging with the abort reason when the signal aborts between pages", async () => {
		const store = await seededStore(countedUpTo(5));
		const controller = new AbortController();
		const read = await readReachable(store, {
			limit: 2,
			signal: controller.signal,
		});

		const walk = async (): Promise<number> => {
			let seen = 0;
			for await (const page of read.pages) {
				seen += page.length;
				controller.abort();
			}
			return seen;
		};

		const rejection = await walk().catch((error: unknown) => error);

		expect(rejection).toBe(controller.signal.reason);
		expect(store.reads).toBe(1);
	});

	it("passes the signal to the first page read and to every continuation read", async () => {
		const store = await seededStore(countedUpTo(5));
		const signals: Array<AbortSignal | undefined> = [];
		const reader: EventStreamReader<Counted> = {
			readStream: (address, options) => {
				signals.push(options.signal);
				return store.readStream(address, options);
			},
		};
		const controller = new AbortController();

		const read = await readReachable(reader, {
			limit: 2,
			signal: controller.signal,
		});
		await collectPages(read.pages);

		expect(signals).toEqual([
			controller.signal,
			controller.signal,
			controller.signal,
		]);
	});

	it("reports the window unreachable when toVersion lies beyond the head", async () => {
		const store = await seededStore(countedUpTo(3));

		const read = await readStreamPages(store, stream, {
			toVersion: 5,
			limit: 2,
		});

		expect(read).toEqual({
			exists: true,
			reachable: false,
			fromVersion: 0,
			lastVersion: 3,
		});
	});

	it("reports the window unreachable when the cursor lies beyond the head", async () => {
		const store = await seededStore(countedUpTo(3));

		const read = await readStreamPages(store, stream, {
			fromVersion: 5,
			limit: 2,
		});

		expect(read).toEqual({
			exists: true,
			reachable: false,
			fromVersion: 5,
			lastVersion: 3,
		});
	});

	it("reports the window unreachable when the cursor lies beyond toVersion", async () => {
		const store = await seededStore(countedUpTo(5));

		const read = await readStreamPages(store, stream, {
			fromVersion: 4,
			toVersion: 3,
			limit: 2,
		});

		expect(read).toEqual({
			exists: true,
			reachable: false,
			fromVersion: 4,
			lastVersion: 5,
		});
	});

	it("throws InvalidEventStreamPageError when a continuation page returns no events", async () => {
		const history = countedUpTo(5);
		const reader = scriptedReader(
			{ exists: true, lastVersion: 5, events: history.slice(0, 2) },
			{ exists: true, lastVersion: 5, events: [] },
		);
		const read = await readReachable(reader, { limit: 2 });

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "empty_page",
			fromVersion: 2,
			targetVersion: 5,
		});
	});

	it("throws InvalidEventStreamPageError when a continuation page reports the stream absent", async () => {
		const history = countedUpTo(3);
		const reader = scriptedReader(
			{ exists: true, lastVersion: 3, events: history.slice(0, 2) },
			{ exists: false, lastVersion: 0, events: [] },
		);
		const read = await readReachable(reader, { limit: 2 });

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "stream_vanished",
			fromVersion: 2,
			targetVersion: 3,
		});
	});

	it("reads a stream that holds one event", async () => {
		const history = countedUpTo(1);
		const store = await seededStore(history);

		const read = await readReachable(store, { limit: 2 });

		expect(read.targetVersion).toBe(1);
		expect(eventIds((await collectPages(read.pages)).flat())).toEqual(
			eventIds(history),
		);
	});

	it.each([
		["0", 0],
		["the string '5'", "5"],
		["NaN", Number.NaN],
		["undefined", undefined],
	])(
		"rejects an existing stream whose first page reports head %s",
		async (_, head) => {
			const reader = scriptedReader({
				exists: true,
				lastVersion: head as number,
				events: [],
			});

			const rejection = await readStreamPages(reader, stream, {
				limit: 2,
			}).catch((error: unknown) => error);

			expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
			expect(rejection).toMatchObject({
				...stream,
				reason: "invalid_head",
				fromVersion: 0,
				lastVersion: head,
			});
		},
	);

	it.each([
		["0", 0],
		["the string '5'", "5"],
	])("rejects a continuation page that reports head %s", async (_, head) => {
		const history = countedUpTo(5);
		const reader = scriptedReader(
			{ exists: true, lastVersion: 5, events: history.slice(0, 2) },
			{
				exists: true,
				lastVersion: head as number,
				events: history.slice(2, 4),
			},
		);
		const read = await readReachable(reader, { limit: 2 });

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "invalid_head",
			fromVersion: 2,
			targetVersion: 5,
			lastVersion: head,
		});
	});

	it("rejects an empty first page while events remain in the window", async () => {
		const reader = scriptedReader(
			{ exists: true, lastVersion: 5, events: [] },
			{ exists: true, lastVersion: 5, events: countedUpTo(2) },
		);

		const rejection = await readStreamPages(reader, stream, {
			limit: 2,
		}).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "empty_page",
			fromVersion: 0,
			targetVersion: 5,
		});
	});

	it("rejects a first page that holds more events than the window up to the head", async () => {
		const reader = scriptedReader({
			exists: true,
			lastVersion: 3,
			events: countedUpTo(4),
		});

		const rejection = await readStreamPages(reader, stream, {
			limit: 10,
		}).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "page_past_target",
			fromVersion: 0,
			targetVersion: 3,
			eventCount: 4,
		});
	});

	it("rejects a first page that runs past toVersion", async () => {
		const reader = scriptedReader({
			exists: true,
			lastVersion: 5,
			events: countedUpTo(3),
		});

		const rejection = await readStreamPages(reader, stream, {
			toVersion: 2,
			limit: 10,
		}).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			reason: "page_past_target",
			fromVersion: 0,
			targetVersion: 2,
			eventCount: 3,
		});
	});

	it("rejects a continuation page that holds more events than the window has left", async () => {
		const history = countedUpTo(6);
		const reader = scriptedReader(
			{ exists: true, lastVersion: 3, events: history.slice(0, 2) },
			{ exists: true, lastVersion: 3, events: history.slice(2, 4) },
		);
		const read = await readReachable(reader, { limit: 2 });

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			reason: "page_past_target",
			fromVersion: 2,
			targetVersion: 3,
			eventCount: 2,
		});
	});

	it("rejects a continuation page that reports a head below the head of the first page", async () => {
		const history = countedUpTo(5);
		const reader = scriptedReader(
			{ exists: true, lastVersion: 5, events: history.slice(0, 2) },
			{ exists: true, lastVersion: 4, events: history.slice(2, 4) },
		);
		const read = await readReachable(reader, { limit: 2 });

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			reason: "head_regressed",
			fromVersion: 2,
			targetVersion: 5,
			lastVersion: 4,
			firstPageLastVersion: 5,
		});
	});

	it("rejects toVersion 0 before any page is read", async () => {
		const store = await seededStore(countedUpTo(3));

		await expect(
			readStreamPages(store, stream, { toVersion: 0, limit: 2 }),
		).rejects.toThrow(/readStreamPages: toVersion/);
		expect(store.reads).toBe(0);
	});

	it.each([0, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects limit %s before any page is read",
		async (limit) => {
			const store = await seededStore(countedUpTo(1));

			await expect(readStreamPages(store, stream, { limit })).rejects.toThrow(
				/readStreamPages: limit must be a positive safe integer/,
			);
			expect(store.reads).toBe(0);
		},
	);

	it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects fromVersion %s before any page is read",
		async (fromVersion) => {
			const store = await seededStore(countedUpTo(1));

			await expect(
				readStreamPages(store, stream, { fromVersion, limit: 2 }),
			).rejects.toThrow(
				/readStreamPages: fromVersion must be a non-negative safe integer/,
			);
			expect(store.reads).toBe(0);
		},
	);
});

describe("pinTargetVersion", () => {
	it.each([
		[0, undefined, 5, 5],
		[2, undefined, 5, 5],
		[5, undefined, 5, 5],
		[0, 3, 5, 3],
		[3, 3, 5, 3],
		[0, 5, 5, 5],
	])(
		"pins fromVersion %s, toVersion %s on a stream at %s to target version %s",
		(fromVersion, toVersion, lastVersion, targetVersion) => {
			expect(pinTargetVersion({ fromVersion, toVersion, lastVersion })).toEqual(
				{ reachable: true, targetVersion },
			);
		},
	);

	it.each([
		[6, undefined, 5],
		[4, 3, 5],
		[0, 6, 5],
		[7, 6, 5],
	])(
		"reports fromVersion %s, toVersion %s on a stream at %s as unreachable",
		(fromVersion, toVersion, lastVersion) => {
			expect(pinTargetVersion({ fromVersion, toVersion, lastVersion })).toEqual(
				{ reachable: false },
			);
		},
	);

	it.each([
		["fromVersion", { fromVersion: -1, lastVersion: 5 }],
		["fromVersion", { fromVersion: 0.5, lastVersion: 5 }],
		["toVersion", { fromVersion: 0, toVersion: 0, lastVersion: 5 }],
		["lastVersion", { fromVersion: 0, lastVersion: 0 }],
		[
			"lastVersion",
			{ fromVersion: 0, lastVersion: Number.MAX_SAFE_INTEGER + 1 },
		],
	])("rejects an invalid %s with RangeError", (field, window) => {
		expect(() => pinTargetVersion(window)).toThrow(
			new RegExp(`pinTargetVersion: ${field} must be`),
		);
	});
});
