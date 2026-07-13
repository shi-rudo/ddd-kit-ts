import { describe, expect, it } from "vitest";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import type { StreamKey } from "../repo/event-store";
import { InMemoryEventStore } from "../repo/in-memory-event-store";
import { createEventStoreContractTests } from "../testing";

type TestEvent = DomainEvent<"ContractEvent", { sequence: number }>;

describe("event-store adapter contract", () => {
	const contractTests = createEventStoreContractTests({
		createEnvironment: async () => ({
			store: new InMemoryEventStore<TestEvent>(),
		}),
		createCollidingStreamKeys: (): readonly [StreamKey, StreamKey] => [
			{ aggregateType: "ContractAlpha", aggregateId: "shared-1" },
			{ aggregateType: "ContractBeta", aggregateId: "shared-1" },
		],
		createEvent: (stream: StreamKey, sequence: number): TestEvent =>
			createDomainEvent("ContractEvent", { sequence }, stream),
	});

	it("contains the qualified-stream isolation proof", () => {
		expect(contractTests.map(({ name }) => name)).toEqual([
			"qualified stream key: equal aggregate ids remain isolated by aggregate type",
		]);
	});

	for (const test of contractTests) {
		it(test.name, test.run);
	}
});
