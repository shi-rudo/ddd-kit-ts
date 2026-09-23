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
	InvalidEventStreamPageError,
	ReplayRejectedError,
	ReplayTargetMismatchError,
	UnreplayableAggregateError,
} from "../../errors/kit-errors";
import { createReplayableStreamPages } from "../../testing/replayable-stream-pages";
import { InMemoryEventStore } from "./adapters/in-memory-event-store";
import { readStreamPages } from "./read-stream-pages";
import {
	type ReplayableStreamPages,
	reconstituteAggregateFromStreamPages,
} from "./reconstitute-from-stream-pages";

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

const countedUpTo = (count: number): Counted[] =>
	Array.from({ length: count }, (_, index) => counted(index + 1));

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
	it("replays every page and yields the aggregate at the target version", async () => {
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

	it("returns ReplayRejectedError with the window of the page that holds a row the fold rejects", async () => {
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
		expect(loaded.error).toBeInstanceOf(ReplayRejectedError);
		expect(loaded.error).toMatchObject({
			...stream,
			fromVersion: 2,
			toVersion: 4,
		});
		expect(loaded.error.cause).toBeInstanceOf(PoisonedRowError);
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
		expect(loaded.error).toBeInstanceOf(ReplayRejectedError);
		expect(loaded.error).toMatchObject({
			...stream,
			fromVersion: 0,
			toVersion: 0,
		});
		expect(loaded.error.cause).toBeInstanceOf(PoisonedRowError);
	});

	it("throws ReplayTargetMismatchError when a replay target off the cursor also rejects an empty history", async () => {
		const read = createReplayableStreamPages<CounterEvent>(stream, {
			fromVersion: 10,
			tail: [],
			targetVersion: 10,
		});
		const offCursorAndRejecting: ReplayableAggregate<CounterId, CounterEvent> =
			{
				id: counterId,
				version: 7 as Version,
				pendingEvents: [],
				replayHistory: () => err(new PoisonedRowError()),
			};

		const rejection = await reconstituteAggregateFromStreamPages(
			() => offCursorAndRejecting,
			read,
		).catch((error: unknown) => error);

		expect(rejection).toBeInstanceOf(ReplayTargetMismatchError);
		expect(rejection).toMatchObject({
			reason: "target_not_at_cursor",
			fromVersion: 10,
			actualVersion: 7,
		});
	});

	it("throws InvalidEventStreamPageError at the first empty page of an adapter", async () => {
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

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
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

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			...stream,
			reason: "page_past_target",
			fromVersion: 2,
			targetVersion: 3,
			eventCount: 2,
		});
		expect(pulls).toBe(2);
	});

	it("rejects a page past the target before any row of it reaches the aggregate", async () => {
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

		expect(rejection).toBeInstanceOf(InvalidEventStreamPageError);
		expect(rejection).toMatchObject({
			reason: "page_past_target",
			fromVersion: 2,
			eventCount: 3,
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
	it("loads a point-in-time aggregate at toVersion below the head", async () => {
		const store = new InMemoryEventStore<CounterEvent>();
		await store.append(stream, countedUpTo(5), { expectedVersion: 0 });
		const read = await readStreamPages(store, stream, {
			toVersion: 3,
			limit: 2,
		});
		if (!read.reachable) throw new Error("the seeded window must be reachable");

		const loaded = await reconstituteAggregateFromStreamPages(
			() => Counter.bare(counterId),
			read,
		);

		if (loaded.isErr()) throw loaded.error;
		expect(loaded.value.version).toBe(3);
		expect(loaded.value.total).toBe(6);
	});
});
