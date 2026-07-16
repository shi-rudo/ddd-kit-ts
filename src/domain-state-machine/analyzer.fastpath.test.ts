import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Passthrough spies on the definition module: the analyzer must not call
// validate/copy itself for a PREPARED definition (the prepared brand means
// both already happened). Module-internal calls inside definition.ts do
// not route through these spies, so a green run proves the analyzer took
// the shared fast-path entry point instead of hand-rolling the two steps.
const spies = vi.hoisted(() => ({
	validate: vi.fn(),
	copy: vi.fn(),
}));

vi.mock("./definition", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./definition")>();
	spies.validate.mockImplementation(actual.validateDomainMachineDefinition);
	spies.copy.mockImplementation(actual.copyDomainMachineDefinition);
	return {
		...actual,
		validateDomainMachineDefinition: spies.validate,
		copyDomainMachineDefinition: spies.copy,
	};
});

import {
	analyzeDomainMachineDefinition,
	type DomainMachineDefinition,
	InvalidDomainMachineDefinitionError,
	prepareDomainMachineDefinition,
} from "./domain-state-machine";

type State = "draft" | "done";
type Input = { readonly type: "Finish" };

const rawDefinition = (): DomainMachineDefinition<
	State,
	{ count: number },
	Input
> => ({
	initial: "draft",
	initialContext: () => ({ count: 0 }),
	states: {
		draft: { on: { Finish: { target: "done" } } },
		done: { terminal: true },
	},
});

describe("analyzeDomainMachineDefinition prepared-definition fast path", () => {
	beforeEach(() => {
		spies.validate.mockClear();
		spies.copy.mockClear();
	});

	it("does not re-validate or re-copy a prepared definition", () => {
		const prepared = prepareDomainMachineDefinition(rawDefinition());
		spies.validate.mockClear();
		spies.copy.mockClear();

		const analysis = analyzeDomainMachineDefinition(prepared);

		expect(analysis.structurallyReachableStates).toEqual(["done", "draft"]);
		expect(spies.validate).not.toHaveBeenCalled();
		expect(spies.copy).not.toHaveBeenCalled();
	});

	it("still validates a raw definition (invalid input keeps throwing)", () => {
		const invalid = {
			...rawDefinition(),
			initial: "nowhere",
		} as unknown as DomainMachineDefinition<State, { count: number }, Input>;

		expect(() => analyzeDomainMachineDefinition(invalid)).toThrow(
			InvalidDomainMachineDefinitionError,
		);
	});

	it("analyzes a raw definition without mutating or trusting it", () => {
		const analysis = analyzeDomainMachineDefinition(rawDefinition());

		expect(analysis.structurallyReachableStates).toEqual(["done", "draft"]);
	});
});
