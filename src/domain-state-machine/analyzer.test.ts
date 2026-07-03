import { describe, expect, it, vi } from "vitest";
import {
	analyzeDomainMachineDefinition,
	type DomainMachineDefinition,
	InvalidDomainMachineDefinitionError,
} from "./domain-state-machine";

type State =
	| "abandoned"
	| "approved"
	| "dead-a"
	| "dead-b"
	| "draft"
	| "orphan"
	| "review"
	| "stuck";

type Input =
	| { readonly type: "Abandon" }
	| { readonly type: "Approve" }
	| { readonly type: "Loop" }
	| { readonly type: "Next" }
	| { readonly type: "Reopen" }
	| { readonly type: "Submit" };

const graphDefinition: DomainMachineDefinition<
	State,
	{ count: number },
	Input
> = {
	initial: "draft",
	initialContext: () => ({ count: 0 }),
	states: {
		stuck: {},
		review: {
			on: {
				Reopen: { target: "draft" },
				Approve: { target: "approved" },
			},
		},
		orphan: { on: { Loop: { target: "orphan" } } },
		draft: {
			on: {
				Submit: { target: "review", guard: () => true },
				Abandon: { target: "abandoned" },
			},
		},
		"dead-b": { on: { Next: { target: "dead-a" } } },
		approved: { terminal: true },
		"dead-a": { on: { Next: { target: "dead-b" } } },
		abandoned: { terminal: true },
	},
};

describe("analyzeDomainMachineDefinition", () => {
	it("returns a deterministic transition matrix and only sound graph diagnostics", () => {
		const analysis = analyzeDomainMachineDefinition(graphDefinition);

		expect(analysis.transitions).toEqual([
			{ state: "dead-a", inputType: "Next", target: "dead-b", guarded: false },
			{ state: "dead-b", inputType: "Next", target: "dead-a", guarded: false },
			{
				state: "draft",
				inputType: "Abandon",
				target: "abandoned",
				guarded: false,
			},
			{ state: "draft", inputType: "Submit", target: "review", guarded: true },
			{ state: "orphan", inputType: "Loop", target: "orphan", guarded: false },
			{
				state: "review",
				inputType: "Approve",
				target: "approved",
				guarded: false,
			},
			{ state: "review", inputType: "Reopen", target: "draft", guarded: false },
		]);
		expect(analysis.diagnostics).toEqual([
			{ code: "unreachable-state", state: "dead-a" },
			{ code: "unreachable-state", state: "dead-b" },
			{ code: "unreachable-state", state: "orphan" },
			{ code: "unreachable-state", state: "stuck" },
			{ code: "structural-dead-end", state: "stuck" },
			{ code: "no-terminal-path", state: "dead-a" },
			{ code: "no-terminal-path", state: "dead-b" },
			{ code: "no-terminal-path", state: "orphan" },
			{ code: "no-terminal-path", state: "stuck" },
		]);
		expect(analysis.structurallyReachableStates).toEqual([
			"abandoned",
			"approved",
			"draft",
			"review",
		]);
		expect(analysis.statesWithTerminalPath).toEqual([
			"abandoned",
			"approved",
			"draft",
			"review",
		]);

		const typedState: State = analysis.transitions[0]?.state ?? "draft";
		const typedInput: Input["type"] =
			analysis.transitions[0]?.inputType ?? "Submit";
		expect([typedState, typedInput]).toEqual(["dead-a", "Next"]);
	});

	it("does not execute any definition callback", () => {
		const called = vi.fn();
		const fail = () => {
			called();
			throw new Error("must not run");
		};
		const definition: DomainMachineDefinition<
			"active" | "done",
			{ valid: boolean },
			{ readonly type: "Finish" }
		> = {
			initial: "active",
			initialContext: fail,
			validateSnapshot: fail,
			states: {
				active: {
					validateContext: fail,
					on: {
						Finish: {
							target: "done",
							guard: fail,
							reduce: fail,
						},
					},
				},
				done: { terminal: true },
			},
		};

		expect(analyzeDomainMachineDefinition(definition)).toMatchObject({
			diagnostics: [],
			structurallyReachableStates: ["active", "done"],
			statesWithTerminalPath: ["active", "done"],
		});
		expect(called).not.toHaveBeenCalled();
	});

	it("returns deeply frozen analysis values", () => {
		const analysis = analyzeDomainMachineDefinition(graphDefinition);

		expect(Object.isFrozen(analysis)).toBe(true);
		expect(Object.isFrozen(analysis.transitions)).toBe(true);
		expect(Object.isFrozen(analysis.transitions[0])).toBe(true);
		expect(Object.isFrozen(analysis.diagnostics)).toBe(true);
		expect(Object.isFrozen(analysis.diagnostics[0])).toBe(true);
		expect(Object.isFrozen(analysis.structurallyReachableStates)).toBe(true);
		expect(Object.isFrozen(analysis.statesWithTerminalPath)).toBe(true);
	});

	it("rejects malformed definitions without invoking accessor properties", () => {
		const getter = vi.fn(() => ({ active: { terminal: true } }));
		const definition = {
			initial: "active",
			initialContext: () => ({}),
		} as Record<string, unknown>;
		Object.defineProperty(definition, "states", {
			enumerable: true,
			get: getter,
		});

		expect(() =>
			analyzeDomainMachineDefinition(
				definition as unknown as DomainMachineDefinition<
					"active",
					Record<string, never>,
					never
				>,
			),
		).toThrow(InvalidDomainMachineDefinitionError);
		expect(getter).not.toHaveBeenCalled();
	});

	it("handles a terminal-only lifecycle without diagnostics", () => {
		const analysis = analyzeDomainMachineDefinition({
			initial: "done",
			initialContext: () => ({}),
			states: { done: { terminal: true } },
		});

		expect(analysis).toMatchObject({
			diagnostics: [],
			transitions: [],
			structurallyReachableStates: ["done"],
			statesWithTerminalPath: ["done"],
		});
	});
});
