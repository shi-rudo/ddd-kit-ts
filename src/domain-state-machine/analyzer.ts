import type { DomainMachineDefinition, DomainMachineInput } from "./contracts";
import { ensureStableDomainMachineDefinition } from "./definition";

export type DomainMachineDefinitionDiagnostic<TState extends string> =
	| {
			readonly code: "unreachable-state";
			readonly state: TState;
	  }
	| {
			readonly code: "structural-dead-end";
			readonly state: TState;
	  }
	| {
			readonly code: "no-terminal-path";
			readonly state: TState;
	  };

export type DomainMachineTransitionDescription<
	TState extends string,
	TInputType extends string,
> = {
	readonly state: TState;
	readonly inputType: TInputType;
	readonly target: TState;
	readonly guarded: boolean;
};

export type DomainMachineDefinitionAnalysis<
	TState extends string,
	TInputType extends string,
> = {
	readonly diagnostics: readonly DomainMachineDefinitionDiagnostic<TState>[];
	readonly transitions: readonly DomainMachineTransitionDescription<
		TState,
		TInputType
	>[];
	/** States reachable when every guard is assumed to allow its transition. */
	readonly structurallyReachableStates: readonly TState[];
	/** States with a graph path to a terminal state when every guard is assumed to allow it. */
	readonly statesWithTerminalPath: readonly TState[];
};

/**
 * Inspects the declarative transition graph without executing definition callbacks.
 * Guarded edges are treated as possible edges, so diagnostics never claim more
 * runtime reachability than the static graph can prove.
 */
export function analyzeDomainMachineDefinition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
): DomainMachineDefinitionAnalysis<TState, TInput["type"]> {
	// The shared entry-point normalization: a prepared definition passes
	// through untouched (already validated, copied, frozen), a raw one
	// pays the documented per-call validate-and-copy.
	const stableDefinition = ensureStableDomainMachineDefinition(definition);
	const states = (Object.keys(stableDefinition.states) as TState[]).sort(
		compareStrings,
	);
	const outgoing = new Map<TState, TState[]>();
	const incoming = new Map<TState, TState[]>();
	const transitions: DomainMachineTransitionDescription<
		TState,
		TInput["type"]
	>[] = [];

	for (const state of states) {
		outgoing.set(state, []);
		incoming.set(state, []);
	}

	for (const state of states) {
		const stateTransitions = stableDefinition.states[state].on;
		const inputTypes = (
			Object.keys(stateTransitions ?? {}) as TInput["type"][]
		).sort(compareStrings);

		for (const inputType of inputTypes) {
			const transition = stateTransitions?.[inputType];
			if (transition === undefined) continue;

			outgoing.get(state)?.push(transition.target);
			incoming.get(transition.target)?.push(state);
			transitions.push(
				Object.freeze({
					state,
					inputType,
					target: transition.target,
					guarded: transition.guard !== undefined,
				}),
			);
		}
	}

	const structurallyReachable = visitGraph(
		[stableDefinition.initial],
		outgoing,
	);
	const terminalStates = states.filter(
		(state) => stableDefinition.states[state].terminal === true,
	);
	const statesWithTerminalPath = visitGraph(terminalStates, incoming);
	const diagnostics: DomainMachineDefinitionDiagnostic<TState>[] = [];

	for (const state of states) {
		if (!structurallyReachable.has(state)) {
			diagnostics.push(Object.freeze({ code: "unreachable-state", state }));
		}
	}
	for (const state of states) {
		if (
			stableDefinition.states[state].terminal !== true &&
			outgoing.get(state)?.length === 0
		) {
			diagnostics.push(Object.freeze({ code: "structural-dead-end", state }));
		}
	}
	for (const state of states) {
		if (!statesWithTerminalPath.has(state)) {
			diagnostics.push(Object.freeze({ code: "no-terminal-path", state }));
		}
	}

	return Object.freeze({
		diagnostics: Object.freeze(diagnostics),
		transitions: Object.freeze(transitions),
		structurallyReachableStates: Object.freeze(
			states.filter((state) => structurallyReachable.has(state)),
		),
		statesWithTerminalPath: Object.freeze(
			states.filter((state) => statesWithTerminalPath.has(state)),
		),
	});
}

function visitGraph<TState extends string>(
	startStates: readonly TState[],
	edges: ReadonlyMap<TState, readonly TState[]>,
): ReadonlySet<TState> {
	const visited = new Set<TState>();
	const pending = [...startStates];

	while (pending.length > 0) {
		const state = pending.pop();
		if (state === undefined || visited.has(state)) continue;

		visited.add(state);
		for (const next of edges.get(state) ?? []) {
			if (!visited.has(next)) pending.push(next);
		}
	}

	return visited;
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
