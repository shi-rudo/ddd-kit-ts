import { deepEqual, StateStoredAggregate } from "@shirudo/ddd-kit";
import { toProblemDetails } from "@shirudo/ddd-kit/http";
import { parseMoneyInput } from "@shirudo/ddd-kit/money";
import { createKitPublicErrors } from "@shirudo/ddd-kit/public-errors";
import { DomainStateMachine } from "@shirudo/ddd-kit/state-machine";
import { createEventStoreContractTests } from "@shirudo/ddd-kit/testing";

const publicEntries = [
	["StateStoredAggregate", StateStoredAggregate],
	["deepEqual", deepEqual],
	["toProblemDetails", toProblemDetails],
	["parseMoneyInput", parseMoneyInput],
	["createKitPublicErrors", createKitPublicErrors],
	["DomainStateMachine", DomainStateMachine],
	["createEventStoreContractTests", createEventStoreContractTests],
] as const;

for (const [expectedName, entry] of publicEntries) {
	if (typeof entry !== "function" || entry.name !== expectedName) {
		throw new Error(`invalid public entry ${expectedName}`);
	}
}
