import { describe, expect, it, vi } from "vite-plus/test";
import type { Version } from "../../domain/aggregate/aggregate";
import { StateStoredAggregate } from "../../domain/aggregate/state-stored-aggregate";
import {
	type CreateDomainEventStampOptions,
	createDomainEvent,
	createDomainEventFactory,
	type DomainEvent,
} from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	DuplicateEventIdError,
	ReentrantEventRecordingError,
	UnmanagedInstanceError,
} from "../../errors/kit-errors";
import { recordPendingEvents } from "./record-pending-events";

type CounterId = Id<"CounterId">;
type CounterChanged = DomainEvent<"CounterChanged", { value: number }>;

class Counter extends StateStoredAggregate<
	{ readonly value: number },
	CounterId,
	CounterChanged
> {
	protected readonly aggregateType = "Counter";

	// biome-ignore lint/complexity/noUselessConstructor: the protected base constructor must be exposed to this test
	constructor(id: CounterId, state: { readonly value: number }) {
		super(id, state);
	}

	change(value: number): void {
		this.setState({ value }, this.createEvent("CounterChanged", { value }));
	}

	/** A decision minted with its identity already, as a factory would. */
	changeRecorded(value: number, eventId: string): void {
		this.setState({ value }, this.recordedChange(value, eventId));
	}

	/** One decision object appended twice in one state change. */
	changeAppendingTwice(value: number): void {
		const decision = this.createEvent("CounterChanged", { value });
		this.setState({ value }, [decision, decision]);
	}

	private recordedChange(value: number, eventId: string): CounterChanged {
		return createDomainEvent(
			"CounterChanged",
			{ value },
			{
				eventId,
				aggregateId: this.id,
				aggregateType: this.aggregateType,
			},
		);
	}
}

const recordedAt = new Date("2027-04-05T06:07:08.000Z");

describe("recordPendingEvents", () => {
	it("records each accepted decision exactly once", () => {
		let id = 0;
		let clockReads = 0;
		const factory = createDomainEventFactory({
			eventIdFactory: () => `event-${++id}`,
			clock: () => {
				clockReads += 1;
				return new Date(`2027-04-05T06:07:0${clockReads}.000Z`);
			},
		});
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.change(1);
		aggregate.change(2);

		const first = recordPendingEvents(aggregate, factory);
		const second = recordPendingEvents(aggregate, factory);

		expect(first.map(({ eventId }) => eventId)).toEqual(["event-1", "event-2"]);
		expect(first.map(({ payload }) => payload.value)).toEqual([1, 2]);
		expect(id).toBe(2);
		expect(clockReads).toBe(2);
		expect(second[0]).toBe(first[0]);
		expect(second[1]).toBe(first[1]);
		expect(aggregate.pendingEvents).toEqual(first);
	});

	it("leaves every pending decision unrecorded when stamping fails", () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.change(1);
		aggregate.change(2);
		let calls = 0;

		expect(() =>
			recordPendingEvents(aggregate, () => {
				calls += 1;
				if (calls === 2) throw new Error("clock unavailable");
				return {
					eventId: `event-${calls}`,
					occurredAt: new Date("2027-04-05T06:07:08.000Z"),
				};
			}),
		).toThrow("clock unavailable");

		expect(aggregate.pendingEvents).toHaveLength(2);
		for (const event of aggregate.pendingEvents) {
			expect(event).not.toHaveProperty("eventId");
			expect(event).not.toHaveProperty("occurredAt");
		}
	});

	it("rejects a stamp provider that triggers a new decision on the aggregate", () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.change(1);

		expect(() =>
			recordPendingEvents(aggregate, (_event, index) => {
				// A decision made mid-recording grows the pending list the map
				// never visits; silently replacing the list would discard it.
				aggregate.change(99);
				return {
					eventId: `event-${index}`,
					occurredAt: new Date("2027-04-05T06:07:08.000Z"),
				};
			}),
		).toThrow(ReentrantEventRecordingError);

		// Recording stayed atomic: every decision, including the re-entrant
		// one, remains pending and unrecorded.
		expect(aggregate.pendingEvents).toHaveLength(2);
		for (const event of aggregate.pendingEvents) {
			expect(event).not.toHaveProperty("eventId");
		}
	});

	it("rejects a stamp provider that reuses one eventId across decisions", () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.change(1);
		aggregate.change(2);

		expect(() =>
			recordPendingEvents(aggregate, () => ({
				eventId: "event-reused",
				occurredAt: new Date("2027-04-05T06:07:08.000Z"),
			})),
		).toThrow(DuplicateEventIdError);

		// Recording stayed atomic: both decisions remain unrecorded.
		expect(aggregate.pendingEvents).toHaveLength(2);
		for (const event of aggregate.pendingEvents) {
			expect(event).not.toHaveProperty("eventId");
		}
	});

	it("stamps every decision with the shared metadata of the recording", () => {
		let id = 0;
		const factory = createDomainEventFactory({
			eventIdFactory: () => `event-${++id}`,
			clock: () => new Date("2027-04-05T06:07:09.000Z"),
		});
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.change(1);
		aggregate.change(2);

		const recorded = recordPendingEvents(aggregate, factory, {
			occurredAt: recordedAt,
			metadata: { correlationId: "request-7" },
		});

		expect(recorded.map(({ eventId }) => eventId)).toEqual([
			"event-1",
			"event-2",
		]);
		expect(recorded.map(({ metadata }) => metadata?.correlationId)).toEqual([
			"request-7",
			"request-7",
		]);
		expect(recorded.map(({ occurredAt }) => occurredAt)).toEqual([
			recordedAt,
			recordedAt,
		]);
	});

	it("mints a fresh eventId per decision when a wider options object carries one", () => {
		let id = 0;
		const factory = createDomainEventFactory({
			eventIdFactory: () => `event-${++id}`,
			clock: () => recordedAt,
		});
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.change(1);
		aggregate.change(2);
		const options: CreateDomainEventStampOptions = {
			eventId: "command-9",
			metadata: { correlationId: "request-9" },
		};

		const recorded = recordPendingEvents(aggregate, factory, options);

		expect(recorded.map(({ eventId }) => eventId)).toEqual([
			"event-1",
			"event-2",
		]);
		expect(recorded.map(({ metadata }) => metadata?.correlationId)).toEqual([
			"request-9",
			"request-9",
		]);
	});

	it("records two facts with distinct eventIds when the same decision is appended twice", () => {
		let id = 0;
		const factory = createDomainEventFactory({
			eventIdFactory: () => `event-${++id}`,
			clock: () => recordedAt,
		});
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.changeAppendingTwice(1);

		const recorded = recordPendingEvents(aggregate, factory);

		expect(recorded).toHaveLength(2);
		expect(recorded.map(({ eventId }) => eventId)).toEqual([
			"event-1",
			"event-2",
		]);
		expect(recorded.map(({ type }) => type)).toEqual([
			"CounterChanged",
			"CounterChanged",
		]);
		expect(recorded.map(({ payload }) => payload)).toEqual([
			{ value: 1 },
			{ value: 1 },
		]);
	});

	it("shares the frozen payload instead of re-cloning it when recording", () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.change(1);
		const pendingPayload = aggregate.pendingEvents[0]?.payload;

		const [recorded] = recordPendingEvents(aggregate, (_event, index) => ({
			eventId: `event-${index}`,
			occurredAt: new Date("2027-04-05T06:07:08.000Z"),
		}));

		// The uncommitted constructor already cloned and deep-froze the
		// payload; recording must not pay a second deep copy per event.
		expect(recorded?.payload).toBe(pendingPayload);
		expect(Object.isFrozen(recorded?.payload)).toBe(true);
	});

	it("records nothing and reads no stamp when no decision is pending", () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		let stamps = 0;

		const recorded = recordPendingEvents(aggregate, () => {
			stamps += 1;
			return { eventId: "unused", occurredAt: recordedAt };
		});

		expect(recorded).toEqual([]);
		expect(Object.isFrozen(recorded)).toBe(true);
		expect(stamps).toBe(0);
	});

	it("passes an already recorded event through and stamps only the decisions", () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.changeRecorded(1, "pre-minted");
		aggregate.change(2);
		const stampedIndexes: number[] = [];

		const recorded = recordPendingEvents(aggregate, (_event, index) => {
			stampedIndexes.push(index);
			return { eventId: `stamp-${index}`, occurredAt: recordedAt };
		});

		expect(recorded[0]).toBe(aggregate.pendingEvents[0]);
		expect(recorded[0]?.eventId).toBe("pre-minted");
		expect(recorded[1]?.eventId).toBe("stamp-1");
		// The index names the position in the pending list, not among the
		// decisions that still need a stamp.
		expect(stampedIndexes).toEqual([1]);
	});

	it("rejects a stamp provider that records the aggregate again while stamping", () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });
		aggregate.change(1);

		expect(() =>
			recordPendingEvents(aggregate, (_event, index) => {
				// A nested recording replaces the pending list with a stamped
				// copy of the same length; the outer recording must not
				// overwrite it with its own stamps.
				recordPendingEvents(aggregate, () => ({
					eventId: "inner",
					occurredAt: recordedAt,
				}));
				return { eventId: `outer-${index}`, occurredAt: recordedAt };
			}),
		).toThrow(ReentrantEventRecordingError);

		expect((aggregate.pendingEvents[0] as CounterChanged).eventId).toBe(
			"inner",
		);
	});

	it("rejects an aggregate that this package did not construct", () => {
		const lookalike = {
			id: "counter-1" as CounterId,
			version: 0 as Version,
			pendingEvents: [] as ReadonlyArray<CounterChanged>,
		};

		let caught: unknown;
		try {
			recordPendingEvents(lookalike, () => ({
				eventId: "event-1",
				occurredAt: new Date("2027-04-05T06:07:08.000Z"),
			}));
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(UnmanagedInstanceError);
		expect((caught as UnmanagedInstanceError).code).toBe("UNMANAGED_INSTANCE");
		expect((caught as UnmanagedInstanceError).message).toContain("counter-1");
	});

	it("resolves the recording capability from a second copy of the module", async () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });

		// A duplicate package installation re-evaluates the module; its
		// copy must find the capability this copy registered.
		vi.resetModules();
		const foreignModule = await import(
			"../../domain/aggregate/pending-event-recording"
		);

		expect(
			foreignModule.pendingEventRecordingCapabilityFor(aggregate),
		).toBeDefined();
	});
});
