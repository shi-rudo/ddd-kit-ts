import { AggregateRoot, deepEqual } from "@shirudo/ddd-kit";
import { toProblemDetails } from "@shirudo/ddd-kit/http";
import { parseMoneyInput } from "@shirudo/ddd-kit/money";
import { createKitPublicErrors } from "@shirudo/ddd-kit/public-errors";
import { createEventStoreContractTests } from "@shirudo/ddd-kit/testing";

const publicEntries = [
	["AggregateRoot", AggregateRoot],
	["deepEqual", deepEqual],
	["toProblemDetails", toProblemDetails],
	["parseMoneyInput", parseMoneyInput],
	["createKitPublicErrors", createKitPublicErrors],
	["createEventStoreContractTests", createEventStoreContractTests],
] as const;

for (const [expectedName, entry] of publicEntries) {
	if (typeof entry !== "function" || entry.name !== expectedName) {
		throw new Error(`invalid public entry ${expectedName}`);
	}
}
