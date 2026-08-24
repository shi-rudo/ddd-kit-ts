import { describe, expect, it } from "vite-plus/test";
import {
	createDomainEvent,
	type DomainEvent,
} from "../domain/event/domain-event";
import { EventBusImpl } from "../messaging/event-bus/event-bus";
import { createEventBusContractTests } from "./index";

type ContractPlaced = DomainEvent<"ContractPlaced", { orderId: string }>;
type ContractShipped = DomainEvent<"ContractShipped", { orderId: string }>;
type ContractEvent = ContractPlaced | ContractShipped;

const address = {
	aggregateType: "ContractOrder",
	aggregateId: "contract-order",
};

describe("event-bus contract suite against the in-memory reference", () => {
	const tests = createEventBusContractTests<ContractEvent>({
		createEnvironment: async () => ({
			bus: new EventBusImpl<ContractEvent>(),
		}),
		createFirstEvent: () =>
			createDomainEvent(
				"ContractPlaced",
				{ orderId: "contract-order" },
				address,
			) as ContractPlaced,
		createSecondEvent: () =>
			createDomainEvent(
				"ContractShipped",
				{ orderId: "contract-order" },
				address,
			) as ContractShipped,
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("the suite has no capability gates: every guarantee is provable in memory", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});
});
