import { err, ok } from "@shirudo/result";
import { describe, expect, it } from "vite-plus/test";
import type {
	ReplayableAggregate,
	Version,
} from "../../domain/aggregate/aggregate";
import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import { EventSourcedAggregate } from "../../domain/aggregate/event-sourced-aggregate";
import {
	type AnyDomainEvent,
	createDomainEvent,
	type DomainEvent,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	DomainError,
	ForeignEventError,
	NonProgressingEventStreamPageError,
	ReplayTargetMismatchError,
	UnreplayableAggregateError,
} from "../../errors/kit-errors";
import { createReplayableStreamPages } from "../../testing/replayable-stream-pages";
import { InMemoryEventStore } from "./adapters/in-memory-event-store";
import type {
	EventStore,
	EventStoreAppendOptions,
	EventStreamReader,
	ReadStreamOptions,
	StreamReadResult,
} from "./event-store";
import {
	type ReachableStreamPages,
	type ReadStreamPagesOptions,
	type ReplayableStreamPages,
	readStreamPages,
	reconstituteAggregateFromStreamPages,
} from "./stream-pages";

type CounterId = Id<"CounterId">;
type CounterState = { total: number };
type Counted = DomainEvent<"Counted", { by: number }>;
type Poisoned = DomainEvent<"Poisoned", Record<string, never>>;
type CounterEvent = Counted | Poisoned;

class PoisonedRowError extends DomainError<"POISONED_ROW"> {
	constructor() {
		super({ code: "POISONED_ROW", message: "the fold rejects this row" });
	}
}

class Counter extends EventSourcedAggregate<
	CounterState,
	CounterId,
	CounterEvent
> {
	protected readonly aggregateType = "Counter";

	static bare(id: CounterId): Counter {
		return new Counter(id, { total: 0 });
	}

	static fromSnapshot(snapshot: {
		id: CounterId;
		total: number;
		version: number;
	}): Counter {
		const counter = new Counter(
			snapshot.id,
			{ total: snapshot.total },
			{ trustInitialState: true },
		);
		counter.markReconstituted(snapshot.version as Version);
		return counter;
	}

	get total(): number {
		return this.state.total;
	}

	count(by: number): void {
		this.apply(this.createEvent("Counted", { by }));
	}

	protected readonly folds = {
		Counted: (state: CounterState, event: { payload: { by: number } }) => ({
			total: state.total + event.payload.by,
		}),
		Poisoned: (): CounterState => {
			throw new PoisonedRowError();
		},
	};
}

const counterId = "counter-1" as CounterId;
const stream: AggregateAddress<CounterId> = {
	aggregateType: "Counter",
	aggregateId: counterId,
};

function counted(by: number, address: AggregateAddress = stream): Counted {
	return createDomainEvent("Counted", { by }, address);
}

function poisoned(): Poisoned {
	return createDomainEvent("Poisoned", {}, stream);
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

/** Answers every continuation read with one fixed page: a broken adapter. */
class StallingEventReader<Evt extends AnyDomainEvent>
	implements EventStreamReader<Evt>
{
	private firstPageRead = false;

	constructor(
		private readonly inner: EventStreamReader<Evt>,
		private readonly continuation: StreamReadResult<Evt>,
	) {}

	readStream(
		address: AggregateAddress,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<Evt>> {
		if (this.firstPageRead) return Promise.resolve(this.continuation);
		this.firstPageRead = true;
		return this.inner.readStream(address, options);
	}
}

/** Returns at most one event per page: a store that pages shorter than the limit. */
class ShortPageReader implements EventStreamReader<CounterEvent> {
	constructor(private readonly inner: CountingEventStore<CounterEvent>) {}

	get reads(): number {
		return this.inner.reads;
	}

	async readStream(
		address: AggregateAddress,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<CounterEvent>> {
		const page = await this.inner.readStream(address, options);
		if (!page.exists) return page;
		return { ...page, events: page.events.slice(0, 1) };
	}
}

async function seededStore(
	events: ReadonlyArray<CounterEvent>,
): Promise<CountingEventStore<CounterEvent>> {
	const store = new CountingEventStore(new InMemoryEventStore<CounterEvent>());
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
	store: EventStreamReader<CounterEvent>,
	options: ReadStreamPagesOptions,
): Promise<ReachableStreamPages<CounterEvent>> {
	const read = await readStreamPages(store, stream, options);
	if (!read.reachable) throw new Error("the seeded window must be reachable");
	return read;
}

describe("readStreamPages", () => {
	it("reports an absent stream from the first page and reads no other", async () => {
		const store = new CountingEventStore(
			new InMemoryEventStore<CounterEvent>(),
		);

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

		const collected: CounterEvent[] = [];
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
		const reader: EventStreamReader<CounterEvent> = {
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

	it("throws NonProgressingEventStreamPageError when a continuation page returns no events", async () => {
		const store = await seededStore(countedUpTo(5));
		const reader = new StallingEventReader(store, {
			exists: true,
			lastVersion: 5,
			events: [],
		});
		const read = await readReachable(reader, { limit: 2 });

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(NonProgressingEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "empty_page",
			fromVersion: 2,
			targetVersion: 5,
		});
	});

	it("throws NonProgressingEventStreamPageError when a continuation page reports the stream absent", async () => {
		const store = await seededStore(countedUpTo(3));
		const reader = new StallingEventReader(store, {
			exists: false,
			lastVersion: 0,
			events: [],
		});
		const read = await readReachable(reader, { limit: 2 });

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(NonProgressingEventStreamPageError);
		expect(rejection).toMatchObject({
			reason: "stream_vanished",
			fromVersion: 2,
			targetVersion: 3,
		});
	});

	it("rejects toVersion 0 before any page is read", async () => {
		const store = await seededStore(countedUpTo(3));

		await expect(
			readStreamPages(store, stream, { toVersion: 0, limit: 2 }),
		).rejects.toThrow(/readStreamPages: toVersion/);
		expect(store.reads).toBe(0);
	});

	it("lets the store reject an invalid limit before any page is read", async () => {
		const store = await seededStore(countedUpTo(1));

		await expect(
			readStreamPages(store, stream, { limit: 0 }),
		).rejects.toBeInstanceOf(RangeError);
	});
});

/** Counts the pages a consumer pulls, so a test can prove where it stopped. */
function countingPulledPages<Evt extends AnyDomainEvent>(
	read: ReplayableStreamPages<Evt>,
): ReplayableStreamPages<Evt> & { readonly pulled: number } {
	let pulled = 0;
	return {
		stream: read.stream,
		fromVersion: read.fromVersion,
		targetVersion: read.targetVersion,
		get pulled(): number {
			return pulled;
		},
		pages: {
			async *[Symbol.asyncIterator]() {
				for await (const page of read.pages) {
					pulled += 1;
					yield page;
				}
			},
		},
	};
}

describe("reconstituteAggregateFromStreamPages", () => {
	it("folds every page and yields the aggregate at the target version", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 0,
			tail: countedUpTo(5),
			targetVersion: 5,
			limit: 2,
		});

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		);

		expect(loaded.isOk()).toBe(true);
		if (loaded.isErr()) throw loaded.error;
		expect(loaded.value.version).toBe(5);
		expect(loaded.value.total).toBe(15);
		expect(loaded.value.pendingEvents).toEqual([]);
	});

	it("catches a snapshot up on the tail after its version only", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 2,
			tail: countedUpTo(5).slice(2),
			targetVersion: 5,
			limit: 2,
		});

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.fromSnapshot({ id: counterId, total: 3, version: 2 }),
			read,
		);

		if (loaded.isErr()) throw loaded.error;
		expect(loaded.value.version).toBe(5);
		expect(loaded.value.total).toBe(15);
	});

	it("loads a snapshot at the target version from a read without pages", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 3,
			tail: [],
			targetVersion: 3,
		});

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.fromSnapshot({ id: counterId, total: 6, version: 3 }),
			read,
		);

		if (loaded.isErr()) throw loaded.error;
		expect(loaded.value.version).toBe(3);
		expect(loaded.value.total).toBe(6);
	});

	it("returns Err and pulls no page after the one with a row the fold rejects", async () => {
		const read = countingPulledPages(
			createReplayableStreamPages<CounterEvent>(stream, {
				fromVersion: 0,
				tail: [...countedUpTo(3), poisoned(), counted(5), counted(6)],
				targetVersion: 6,
				limit: 2,
			}),
		);

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		);

		expect(loaded.isErr()).toBe(true);
		if (loaded.isOk()) throw new Error("a poisoned row must not load");
		expect(loaded.error).toBeInstanceOf(PoisonedRowError);
		expect(read.pulled).toBe(2);
	});

	it("throws ReplayTargetMismatchError before the first page when the replay target does not stand at the cursor", async () => {
		const read = countingPulledPages(
			createReplayableStreamPages<CounterEvent>(stream, {
				fromVersion: 2,
				tail: countedUpTo(5).slice(2),
				targetVersion: 5,
			}),
		);

		const rejection = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ReplayTargetMismatchError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "target_not_at_cursor",
			fromVersion: 2,
			targetVersion: 5,
			actualVersion: 0,
		});
		expect(read.pulled).toBe(0);
	});

	it("throws ReplayTargetMismatchError when the pages end short of the target", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 0,
			tail: countedUpTo(3),
			targetVersion: 5,
		});

		const rejection = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ReplayTargetMismatchError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "pages_short_of_target",
			fromVersion: 0,
			targetVersion: 5,
			actualVersion: 3,
		});
	});

	it("returns Err when a foreign implementation of ReplayableAggregate rejects an empty history", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 0,
			tail: countedUpTo(2),
			targetVersion: 2,
		});
		const rejectsEmptyHistory: ReplayableAggregate<CounterId, CounterEvent> = {
			id: counterId,
			version: 0 as Version,
			pendingEvents: [],
			replayHistory: (history) =>
				history.length === 0 ? err(new PoisonedRowError()) : ok(),
		};

		const loaded = await reconstituteAggregateFromStreamPages(
			() => rejectsEmptyHistory,
			read,
		);

		expect(loaded.isErr()).toBe(true);
		if (loaded.isOk())
			throw new Error("a rejected priming replay must not load");
		expect(loaded.error).toBeInstanceOf(PoisonedRowError);
	});

	it("throws NonProgressingEventStreamPageError at the first empty page of an adapter", async () => {
		let pulls = 0;
		const read: ReplayableStreamPages<CounterEvent> = {
			stream,
			fromVersion: 0,
			targetVersion: 3,
			pages: {
				[Symbol.asyncIterator]: async function* () {
					pulls += 1;
					yield [counted(1), counted(2)];
					pulls += 1;
					yield [];
					pulls += 1;
					yield [counted(3)];
				},
			},
		};

		const rejection = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(NonProgressingEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "empty_page",
			fromVersion: 2,
			targetVersion: 3,
		});
		expect(pulls).toBe(2);
	});

	it("rejects the first page that runs past the target and pulls no further page", async () => {
		let pulls = 0;
		const read: ReplayableStreamPages<CounterEvent> = {
			stream,
			fromVersion: 0,
			targetVersion: 3,
			pages: {
				[Symbol.asyncIterator]: async function* () {
					for (let by = 1; ; by += 2) {
						pulls += 1;
						yield [counted(by), counted(by + 1)];
					}
				},
			},
		};

		const rejection = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ReplayTargetMismatchError);
		expect(rejection).toMatchObject({
			reason: "pages_outside_window",
			fromVersion: 0,
			targetVersion: 3,
			actualVersion: 4,
		});
		expect(pulls).toBe(2);
	});

	it("rejects a page past the target before it folds any row of it", async () => {
		const read: ReplayableStreamPages<CounterEvent> = {
			stream,
			fromVersion: 0,
			targetVersion: 3,
			pages: {
				[Symbol.asyncIterator]: async function* () {
					yield [counted(1), counted(2)];
					yield [counted(3), counted(4), poisoned()];
				},
			},
		};

		const rejection = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ReplayTargetMismatchError);
		expect(rejection).toMatchObject({
			reason: "pages_outside_window",
			actualVersion: 5,
		});
	});

	it("rejects a target of version 0 before the replay target is built", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 0,
			tail: [],
			targetVersion: 0,
		});
		let built = 0;

		await expect(
			reconstituteAggregateFromStreamPages(() => {
				built += 1;
				return Counter.bare(counterId);
			}, read),
		).rejects.toThrow(
			/reconstituteAggregateFromStreamPages: targetVersion must be a positive safe integer/,
		);
		expect(built).toBe(0);
	});

	it("rejects a negative fromVersion before the replay target is built", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: -1,
			tail: [],
			targetVersion: 3,
		});

		await expect(
			reconstituteAggregateFromStreamPages(() => Counter.bare(counterId), read),
		).rejects.toThrow(
			/reconstituteAggregateFromStreamPages: fromVersion must be a non-negative safe integer/,
		);
	});

	it("rejects an inverted window before the replay target is built", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 5,
			tail: [],
			targetVersion: 3,
		});

		await expect(
			reconstituteAggregateFromStreamPages(() => Counter.bare(counterId), read),
		).rejects.toThrow(/fromVersion must not exceed targetVersion/);
	});

	it("rejects a dirty replay target on a read without pages", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 3,
			tail: [],
			targetVersion: 3,
		});
		const dirtyTarget = (): Counter => {
			const counter = Counter.fromSnapshot({
				id: counterId,
				total: 6,
				version: 3,
			});
			counter.count(1);
			return counter;
		};

		await expect(
			reconstituteAggregateFromStreamPages(dirtyTarget, read),
		).rejects.toBeInstanceOf(UnreplayableAggregateError);
	});

	it("lets a foreign row throw past the Result", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 0,
			tail: countedUpTo(2),
			targetVersion: 2,
		});

		await expect(
			reconstituteAggregateFromStreamPages(
				() => Counter.bare("counter-2" as CounterId),
				read,
			),
		).rejects.toBeInstanceOf(ForeignEventError);
	});
});

describe("readStreamPages with reconstituteAggregateFromStreamPages", () => {
	it("loads the aggregate as of toVersion below the head", async () => {
		const store = await seededStore(countedUpTo(5));
		const read = await readReachable(store, { toVersion: 3, limit: 2 });

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		);

		if (loaded.isErr()) throw loaded.error;
		expect(loaded.value.version).toBe(3);
		expect(loaded.value.total).toBe(6);
	});
});
