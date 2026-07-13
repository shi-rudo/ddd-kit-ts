import { describe, expect, it } from "vitest";
import type { AggregateAddress } from "../aggregate/aggregate-address";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { InMemoryEventStore } from "../repo/in-memory-event-store";
import { createEventStoreContractTests } from "../testing";

type TestEvent = DomainEvent<"ContractEvent", { sequence: number }>;

describe("event-store adapter contract", () => {
	const contractTests = createEventStoreContractTests({
		createEnvironment: async () => ({
			store: new InMemoryEventStore<TestEvent>(),
		}),
		createCollidingStreamKeys: (): readonly [
			AggregateAddress,
			AggregateAddress,
		] => [
			{ aggregateType: "ContractAlpha", aggregateId: "shared-1" },
			{ aggregateType: "ContractBeta", aggregateId: "shared-1" },
		],
		createEvent: (stream: AggregateAddress, sequence: number): TestEvent =>
			createDomainEvent("ContractEvent", { sequence }, stream),
	});

	it("contains the qualified-stream isolation proof", () => {
		expect(contractTests.map(({ name }) => name)).toEqual([
			"unknown stream: read reports explicit absence at version zero",
			"empty append: no version check and no stream creation",
			"qualified stream key: equal aggregate ids remain isolated by aggregate type",
			"append/read: event order and fromVersion slicing are preserved",
			"read state: empty and beyond-head windows retain existence and the actual stream head",
			"qualified fromVersion: slicing one type cannot observe a colliding raw id",
			"OCC: a rejected multi-event append is atomic and maps to ConcurrencyConflictError",
			"OCC: duplicate create is rejected atomically with a sanctioned kit error",
			"OCC: an expectedVersion ahead of an unknown stream conflicts without creating it",
			"read ownership: a mutation attempt cannot mutate the stream",
		]);
	});

	for (const test of contractTests) {
		it(test.name, test.run);
	}
});
