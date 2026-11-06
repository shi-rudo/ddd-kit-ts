import { describe, expect, it } from "vite-plus/test";
import type { AggregateIdentity } from "../domain/aggregate/aggregate-identity";
import {
	createDomainEvent,
	type DomainEvent,
} from "../domain/event/domain-event";
import { InMemoryEventStore } from "../persistence/event-store/adapters/in-memory-event-store";
import type {
	EventStoreAppendOptions,
	ReadStreamOptions,
	StreamReadResult,
} from "../persistence/event-store/event-store";
import { createEventStoreContractTests } from "./index";

type ContractStepRecorded = DomainEvent<
	"ContractStepRecorded",
	{ sequence: number }
>;

/** A store whose read loses what JSON does not keep, without an error. */
class StoreThatLosesValuesInJson extends InMemoryEventStore<ContractStepRecorded> {
	override async readStream(
		stream: AggregateIdentity,
		options: ReadStreamOptions,
	): Promise<StreamReadResult<ContractStepRecorded>> {
		const read = await super.readStream(stream, options);
		if (!read.exists) return read;
		return {
			...read,
			events: read.events.map((event) => ({
				...event,
				payload: JSON.parse(JSON.stringify(event.payload)),
			})),
		};
	}
}

/**
 * A store that rejects a Set, a Map, and undefined, but changes a Date. Its JSON
 * replacer never sees the Date, because `toJSON` runs first.
 */
class StoreThatChangesOnlyADate extends StoreThatLosesValuesInJson {
	override async append(
		stream: AggregateIdentity,
		events: ReadonlyArray<ContractStepRecorded>,
		options: EventStoreAppendOptions,
	): Promise<void> {
		for (const event of events) {
			JSON.stringify(event.payload, (_key, value: unknown) => {
				if (
					value instanceof Set ||
					value instanceof Map ||
					value === undefined
				) {
					throw new TypeError("the store keeps only JSON");
				}
				return value;
			});
		}
		await super.append(stream, events, options);
	}
}

const harness = {
	createEnvironment: async () => ({
		store: new InMemoryEventStore<ContractStepRecorded>(),
	}),
	createCollidingStreamKeys: (): readonly [
		AggregateIdentity,
		AggregateIdentity,
	] => [
		{ aggregateType: "ContractAlpha", aggregateId: "shared-1" },
		{ aggregateType: "ContractBeta", aggregateId: "shared-1" },
	],
	createEvent: (
		stream: AggregateIdentity,
		sequence: number,
	): ContractStepRecorded =>
		createDomainEvent("ContractStepRecorded", { sequence }, stream),
};

describe("event-store adapter contract", () => {
	const contractTests = createEventStoreContractTests(harness);

	it("lists every contract test by name", () => {
		expect(contractTests.map(({ name }) => name)).toEqual([
			"absent stream: read reports explicit absence at version zero",
			"empty append: no version check and no stream creation",
			"unstamped event: an append rejects an event without an eventId with TypeError and writes nothing",
			"qualified stream key: equal aggregate ids remain isolated by aggregate type",
			"append/read: event order and fromVersion slicing are preserved",
			"paged read: limit bounds every page and fromVersion continues without gaps or duplicates",
			"readStreamPages: the pages walk the pinned prefix and stop before a later append",
			"readStreamPages: toVersion below the head is the target version and the pages end there",
			"readStreamPages: toVersion beyond the head is unreachable and names the head",
			"readStreamPages: a cursor inside the stream reads only the events after it",
			"readStreamPages: a cursor beyond the head is unreachable and names the head",
			"read options: invalid limits and stream positions fail loudly",
			"bounded read: toVersion is inclusive while lastVersion remains the actual head",
			"bounded read edges: zero, beyond-head, and inverted ranges are empty or clamped",
			"read state: empty and beyond-head windows retain existence and the actual stream head",
			"page bounds: an existing stream reports a head of at least 1 and no page holds more events than its window",
			"qualified fromVersion: slicing one type cannot observe a colliding raw id",
			"OCC: a rejected multi-event append is atomic and maps to ConcurrencyConflictError",
			"OCC: duplicate create is rejected atomically with a sanctioned kit error",
			"OCC: an expectedVersion ahead of an absent stream conflicts without creating it",
			"read ownership: a mutation attempt cannot mutate the stream",
			"fidelity: a Date is stored exactly or rejected",
			"fidelity: a Set is stored exactly or rejected",
			"fidelity: a Map is stored exactly or rejected",
			"fidelity: an undefined property is stored exactly or rejected",
		]);
	});

	for (const test of contractTests) {
		it(test.name, test.run);
	}

	it("the fidelity test kills a store that changes a value through JSON", async () => {
		const fidelityTest = createEventStoreContractTests({
			...harness,
			createEnvironment: async () => ({
				store: new StoreThatLosesValuesInJson(),
			}),
		}).find((test) => test.name.startsWith("fidelity:"));

		await expect(fidelityTest?.run()).rejects.toThrow(
			/changed a Date without an error/,
		);
	});

	it("the fidelity test of a Date kills a store that rejects only the other values", async () => {
		const dateTest = createEventStoreContractTests({
			...harness,
			createEnvironment: async () => ({
				store: new StoreThatChangesOnlyADate(),
			}),
		}).find(
			(test) => test.name === "fidelity: a Date is stored exactly or rejected",
		);

		await expect(dateTest?.run()).rejects.toThrow(
			/An event store changed a Date without an error/,
		);
	});
});
