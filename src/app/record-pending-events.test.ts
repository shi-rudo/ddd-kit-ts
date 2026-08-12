import { describe, expect, it } from "vite-plus/test";
import { AggregateRoot } from "../aggregate/aggregate-root";
import {
	createDomainEventFactory,
	type DomainEvent,
} from "../aggregate/domain-event";
import { ReentrantEventRecordingError } from "../core/errors";
import type { Id } from "../core/id";
import { recordPendingEvents } from "./record-pending-events";

type CounterId = Id<"CounterId">;
type CounterChanged = DomainEvent<"CounterChanged", { value: number }>;

class Counter extends AggregateRoot<
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
		this.commit({ value }, this.createEvent("CounterChanged", { value }));
	}
}

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

	it("shares the recording capability registry across package copies", () => {
		const aggregate = new Counter("counter-1" as CounterId, { value: 0 });

		// The registry lives behind a Symbol.for key on globalThis, like the
		// lifecycle registry: a second loaded copy of the kit resolves the
		// same WeakMap instead of a module-local one it cannot see into.
		const registry = Object.getOwnPropertyDescriptor(
			globalThis,
			Symbol.for("@shirudo/ddd-kit/pending-event-recording-registry/v1"),
		)?.value as WeakMap<object, unknown> | undefined;

		expect(registry).toBeInstanceOf(WeakMap);
		expect(registry?.has(aggregate)).toBe(true);
	});
});
