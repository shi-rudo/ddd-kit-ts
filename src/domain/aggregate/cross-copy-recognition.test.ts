import { describe, expect, it, vi } from "vite-plus/test";
import {
	createDomainEvent,
	type DomainEvent,
	isRecordedDomainEvent,
	type UncommittedDomainEventOf,
} from "../event/domain-event";
import type { Id } from "../identity/id";
import { EventSourcedAggregate } from "./event-sourced-aggregate";
import { pendingEventLifecycleCapabilityFor } from "./pending-event-lifecycle";
import { StateStoredAggregate } from "./state-stored-aggregate";

// A duplicate npm dependency or a plugin bundle loads a second copy of the
// kit. Its module-private state (the mint WeakSet, a private registry) is
// invisible to this copy; only the shared Symbol.for brands and registry
// keys connect the two. vi.resetModules() followed by a dynamic import
// re-evaluates a module exactly like such a second copy would. The reset
// drops the module registry of the whole file. These tests live apart from
// the aggregate suites, so no other test can observe a stale registry.

type TestId = Id<"TestId">;
type TestState = { value: number };
type ValueUpdated = DomainEvent<"ValueUpdated", { newValue: number }>;

class ApplyingAggregate extends EventSourcedAggregate<
	TestState,
	TestId,
	ValueUpdated
> {
	protected readonly aggregateType = "ApplyingAggregate";

	constructor(id: TestId) {
		super(id, { value: 0 });
	}

	get value(): number {
		return this.state.value;
	}

	applyEvent(event: ValueUpdated): void {
		this.apply(event);
	}

	protected readonly folds = {
		ValueUpdated: (
			state: TestState,
			event: UncommittedDomainEventOf<ValueUpdated>,
		): TestState => ({ ...state, value: event.payload.newValue }),
	};
}

class NotingAggregate extends StateStoredAggregate<TestState, TestId> {
	protected readonly aggregateType = "NotingAggregate";

	constructor(id: TestId) {
		super(id, { value: 0 });
	}
}

describe("recognition across package copies", () => {
	it("apply accepts an event minted by a second copy of the kit", async () => {
		// The event carries the shared recorded brand instead of a WeakSet
		// membership this copy could see; the gate accepts it. The brand is
		// cooperative by design: the gate catches accidental literals, it is
		// not a security boundary.
		const aggregate = new ApplyingAggregate("test-1" as TestId);
		vi.resetModules();
		const secondCopy = await import("../event/domain-event");
		expect(secondCopy.createDomainEvent).not.toBe(createDomainEvent);
		const foreignEvent = secondCopy.createDomainEvent("ValueUpdated", {
			newValue: 3,
		}) as ValueUpdated;

		aggregate.applyEvent(foreignEvent);

		expect(aggregate.value).toBe(3);
	});

	it("a second copy of the kit recognizes the address-stamped copy apply mints", async () => {
		const aggregate = new ApplyingAggregate("test-1" as TestId);
		aggregate.applyEvent(
			createDomainEvent("ValueUpdated", { newValue: 5 }) as ValueUpdated,
		);
		const stamped = aggregate.pendingEvents[0];
		expect(stamped).toBeDefined();

		vi.resetModules();
		const secondCopy = await import("../event/domain-event");
		expect(secondCopy.isRecordedDomainEvent).not.toBe(isRecordedDomainEvent);

		expect(secondCopy.isRecordedDomainEvent(stamped as ValueUpdated)).toBe(
			true,
		);
	});

	it("a second copy of the lifecycle module resolves the capability this copy registered", async () => {
		const aggregate = new NotingAggregate("test-1" as TestId);

		vi.resetModules();
		const secondCopy = await import("./pending-event-lifecycle");
		expect(secondCopy.pendingEventLifecycleCapabilityFor).not.toBe(
			pendingEventLifecycleCapabilityFor,
		);

		expect(
			secondCopy.pendingEventLifecycleCapabilityFor(aggregate),
		).toBeDefined();
	});
});
