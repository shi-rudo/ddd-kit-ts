import { describe, expect, it } from "vite-plus/test";
import type { Version } from "../../domain/aggregate/aggregate";
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
	ReplayHeadMismatchError,
	UnreplayableAggregateError,
} from "../../errors/kit-errors";
import { InMemoryEventStore } from "./adapters/in-memory-event-store";
import type {
	EventStore,
	EventStoreAppendOptions,
	ReadStreamOptions,
	StreamReadResult,
} from "./event-store";
import {
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

	static fromSnapshot(id: CounterId, total: number, version: number): Counter {
		const counter = new Counter(id, { total }, { trustInitialState: true });
		counter.markReconstituted(version as Version);
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
class StallingEventStore<
	Evt extends AnyDomainEvent,
> extends CountingEventStore<Evt> {
	constructor(
		inner: EventStore<Evt>,
		private readonly continuation: StreamReadResult<Evt>,
	) {
		super(inner);
	}

	override async readStream(
		address: AggregateAddress,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<Evt>> {
		if (this.reads > 0) {
			this.reads += 1;
			return this.continuation;
		}
		return super.readStream(address, options);
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

function rejectsToVersion(
	store: EventStore<CounterEvent>,
	options: ReadStreamOptions,
): void {
	// @ts-expect-error the read pins its own upper bound; toVersion is not accepted
	void readStreamPages(store, stream, options);
}
void rejectsToVersion;

describe("readStreamPages", () => {
	it("reports an absent stream from the first page and reads no other", async () => {
		const store = new CountingEventStore(
			new InMemoryEventStore<CounterEvent>(),
		);

		const read = await readStreamPages(store, stream, { limit: 2 });

		expect(read.exists).toBe(false);
		expect(store.reads).toBe(1);
	});

	it("pins the head on the first page and walks the pages in append order within the limit", async () => {
		const history = countedUpTo(5);
		const store = await seededStore(history);

		const read = await readStreamPages(store, stream, { limit: 2 });
		if (!read.exists) throw new Error("the seeded stream must exist");
		const pages = await collectPages(read.pages);

		expect(read.targetVersion).toBe(5);
		expect(read.stream).toEqual(stream);
		expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
		expect(eventIds(pages.flat())).toEqual(eventIds(history));
		expect(store.reads).toBe(3);
	});

	it("stops at the pinned head when another writer appends during the iteration", async () => {
		const history = countedUpTo(5);
		const store = await seededStore(history);
		const read = await readStreamPages(store, stream, { limit: 2 });
		if (!read.exists) throw new Error("the seeded stream must exist");

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
		const read = await readStreamPages(store, stream, { limit: 2 });
		if (!read.exists) throw new Error("the seeded stream must exist");

		const firstPass = await collectPages(read.pages);
		const secondPass = await collectPages(read.pages);

		expect(eventIds(firstPass.flat())).toEqual(eventIds(history));
		expect(eventIds(secondPass.flat())).toEqual(eventIds(history));
		expect(store.reads).toBe(5);
	});

	it("yields no page for an empty window and keeps the pinned head", async () => {
		const store = await seededStore(countedUpTo(3));

		const read = await readStreamPages(store, stream, {
			fromVersion: 3,
			limit: 2,
		});
		if (!read.exists) throw new Error("the seeded stream must exist");

		expect(read.targetVersion).toBe(3);
		expect(await collectPages(read.pages)).toEqual([]);
	});

	it("throws NonProgressingEventStreamPageError when a continuation page returns no events", async () => {
		const store = new StallingEventStore(
			new InMemoryEventStore<CounterEvent>(),
			{ exists: true, lastVersion: 5, events: [] },
		);
		await store.append(stream, countedUpTo(5), { expectedVersion: 0 });
		const read = await readStreamPages(store, stream, { limit: 2 });
		if (!read.exists) throw new Error("the seeded stream must exist");

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(NonProgressingEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			fromVersion: 2,
			targetVersion: 5,
		});
	});

	it("throws NonProgressingEventStreamPageError when a continuation page reports the stream absent", async () => {
		const store = new StallingEventStore(
			new InMemoryEventStore<CounterEvent>(),
			{ exists: false, lastVersion: 0, events: [] },
		);
		await store.append(stream, countedUpTo(3), { expectedVersion: 0 });
		const read = await readStreamPages(store, stream, { limit: 2 });
		if (!read.exists) throw new Error("the seeded stream must exist");

		const rejection = await collectPages(read.pages).catch(
			(error: unknown) => error,
		);

		expect(rejection).toBeInstanceOf(NonProgressingEventStreamPageError);
		expect(rejection).toMatchObject({ fromVersion: 2, targetVersion: 3 });
	});

	it("lets the store reject an invalid limit before any page is read", async () => {
		const store = await seededStore(countedUpTo(1));

		await expect(
			readStreamPages(store, stream, { limit: 0 }),
		).rejects.toBeInstanceOf(RangeError);
	});
});

describe("reconstituteAggregateFromStreamPages", () => {
	it("folds every page and yields the aggregate at the pinned head", async () => {
		const store = await seededStore(countedUpTo(5));
		const read = await readStreamPages(store, stream, { limit: 2 });
		if (!read.exists) throw new Error("the seeded stream must exist");

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
		const store = await seededStore(countedUpTo(5));
		const read = await readStreamPages(store, stream, {
			fromVersion: 2,
			limit: 2,
		});
		if (!read.exists) throw new Error("the seeded stream must exist");

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.fromSnapshot(counterId, 3, 2),
			read,
		);

		if (loaded.isErr()) throw loaded.error;
		expect(loaded.value.version).toBe(5);
		expect(loaded.value.total).toBe(15);
	});

	it("loads a snapshot at the head without a page", async () => {
		const store = await seededStore(countedUpTo(3));
		const read = await readStreamPages(store, stream, {
			fromVersion: 3,
			limit: 2,
		});
		if (!read.exists) throw new Error("the seeded stream must exist");

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.fromSnapshot(counterId, 6, 3),
			read,
		);

		if (loaded.isErr()) throw loaded.error;
		expect(loaded.value.version).toBe(3);
		expect(loaded.value.total).toBe(6);
		expect(store.reads).toBe(1);
	});

	it("returns Err and stops reading when a later page holds a row the fold rejects", async () => {
		const store = await seededStore([
			...countedUpTo(3),
			poisoned(),
			counted(5),
			counted(6),
		]);
		const read = await readStreamPages(store, stream, { limit: 2 });
		if (!read.exists) throw new Error("the seeded stream must exist");

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		);

		expect(loaded.isErr()).toBe(true);
		if (loaded.isOk()) throw new Error("a poisoned row must not load");
		expect(loaded.error).toBeInstanceOf(PoisonedRowError);
		expect(store.reads).toBe(2);
	});

	it("throws ReplayHeadMismatchError when the replay target starts beyond the pinned head", async () => {
		const store = await seededStore(countedUpTo(3));
		const read = await readStreamPages(store, stream, {
			fromVersion: 5,
			limit: 2,
		});
		if (!read.exists) throw new Error("the seeded stream must exist");

		const rejection = await reconstituteAggregateFromStreamPages(
			() => Counter.fromSnapshot(counterId, 0, 5),
			read,
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ReplayHeadMismatchError);
		expect(rejection).toMatchObject({
			...stream,
			targetVersion: 3,
			actualVersion: 5,
		});
	});

	it("throws ReplayHeadMismatchError when the replay target does not start at the cursor", async () => {
		const store = await seededStore(countedUpTo(5));
		const read = await readStreamPages(store, stream, {
			fromVersion: 2,
			limit: 2,
		});
		if (!read.exists) throw new Error("the seeded stream must exist");

		const rejection = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ReplayHeadMismatchError);
		expect(rejection).toMatchObject({ targetVersion: 5, actualVersion: 3 });
	});

	it("rejects a dirty replay target on a read without pages", async () => {
		const store = await seededStore(countedUpTo(3));
		const read = await readStreamPages(store, stream, {
			fromVersion: 3,
			limit: 2,
		});
		if (!read.exists) throw new Error("the seeded stream must exist");
		const dirtyTarget = (): Counter => {
			const counter = Counter.fromSnapshot(counterId, 6, 3);
			counter.count(1);
			return counter;
		};

		await expect(
			reconstituteAggregateFromStreamPages(dirtyTarget, read),
		).rejects.toBeInstanceOf(UnreplayableAggregateError);
	});

	it("lets a foreign row throw past the Result", async () => {
		const store = await seededStore(countedUpTo(2));
		const read = await readStreamPages(store, stream, { limit: 2 });
		if (!read.exists) throw new Error("the seeded stream must exist");

		await expect(
			reconstituteAggregateFromStreamPages(
				() => Counter.bare("counter-2" as CounterId),
				read,
			),
		).rejects.toBeInstanceOf(ForeignEventError);
	});
});
