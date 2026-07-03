import type {
	DomainMachineDefinition,
	DomainMachineInput,
	DomainMachineReadonly,
	DomainMachineSnapshot,
	DomainTransitionOutcome,
} from "./contracts";
import {
	copyDomainMachineDefinition,
	validateDomainMachineDefinition,
} from "./definition";
import { ReentrantDomainStateMachineEvaluationError } from "./errors";
import {
	createDomainMachineSnapshot,
	validateDomainMachineSnapshot,
	validateDomainMachineSnapshotInvariant,
} from "./snapshot";
import {
	canTransitionPreparedDomainState,
	createInitialDomainMachineSnapshotFromPrepared,
	transitionPreparedDomainState,
} from "./transition";

export type {
	DomainMachineDefinitionAnalysis,
	DomainMachineDefinitionDiagnostic,
	DomainMachineTransitionDescription,
} from "./analyzer";
export { analyzeDomainMachineDefinition } from "./analyzer";
export type {
	DomainMachineDefinition,
	DomainMachineInput,
	DomainMachineReadonly,
	DomainMachineSnapshot,
	DomainStateNode,
	DomainTransition,
	DomainTransitionGuardResult,
	DomainTransitionOutcome,
	DomainTransitionResult,
} from "./contracts";
export {
	DomainTransitionGuardRejectedError,
	InvalidDomainMachineContextError,
	InvalidDomainMachineDefinitionError,
	InvalidDomainMachineInputError,
	InvalidDomainMachineSnapshotError,
	InvalidDomainTransitionError,
	InvalidDomainTransitionGuardResultError,
	InvalidDomainTransitionResultError,
	ReentrantDomainStateMachineEvaluationError,
} from "./errors";
export {
	canTransitionDomainState,
	createInitialDomainMachineSnapshot,
	transitionDomainState,
} from "./transition";

/**
 * Stateful convenience wrapper around the pure domain transition functions.
 *
 * Persist {@link snapshot}, not the machine instance. Pass a restored snapshot
 * to the second constructor overload to validate and reconstitute a machine.
 */
export class DomainStateMachine<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput = never,
> {
	private readonly definition: DomainMachineDefinition<
		TState,
		TContext,
		TInput,
		TOutput
	>;

	#snapshot: DomainMachineSnapshot<TState, TContext>;
	#evaluating = false;

	constructor(
		definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
	);
	constructor(
		definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
		snapshot: DomainMachineSnapshot<TState, TContext> | undefined,
	);
	constructor(
		definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
		...snapshotInput: [] | [DomainMachineSnapshot<TState, TContext> | undefined]
	) {
		validateDomainMachineDefinition(definition);
		this.definition = copyDomainMachineDefinition(definition);
		// Resolve the overload by the argument value, not the rest-parameter
		// arity: an explicit `undefined` snapshot (a natural result of a
		// nullable `repo.loadSnapshot(id)` or `map.get(id)` passed straight
		// through) means "no snapshot", so it must fall back to the initial
		// snapshot instead of failing validation.
		const [suppliedSnapshot] = snapshotInput;
		if (suppliedSnapshot !== undefined) {
			validateDomainMachineSnapshot(this.definition, suppliedSnapshot);
			this.#snapshot = createDomainMachineSnapshot<TState, TContext>(
				suppliedSnapshot,
			);
			validateDomainMachineSnapshotInvariant(this.definition, this.#snapshot);
		} else {
			this.#snapshot = createInitialDomainMachineSnapshotFromPrepared(
				this.definition,
			);
		}
	}

	/** Returns a defensive, deeply frozen copy of the current snapshot. */
	get snapshot(): DomainMachineSnapshot<TState, TContext> {
		return createDomainMachineSnapshot<TState, TContext>(this.#snapshot);
	}

	/** Current named control state. */
	get state(): TState {
		return this.#snapshot.state;
	}

	/** Current deeply readonly context. */
	get context(): DomainMachineReadonly<TContext> {
		return this.#snapshot.context;
	}

	/** Whether the current state permanently forbids outgoing transitions. */
	isTerminal(): boolean {
		return this.definition.states[this.state].terminal === true;
	}

	/** Checks a transition without changing the current snapshot. */
	can(input: TInput): boolean {
		return this.evaluate(() =>
			canTransitionPreparedDomainState(this.definition, this.#snapshot, input),
		);
	}

	/** Applies an input and advances the current snapshot on success. */
	dispatch(input: TInput): DomainTransitionOutcome<TState, TContext, TOutput> {
		return this.evaluate(() => {
			const result = transitionPreparedDomainState(
				this.definition,
				this.#snapshot,
				input,
			);
			this.#snapshot = result.snapshot;
			return result;
		});
	}

	private evaluate<TResult>(operation: () => TResult): TResult {
		if (this.#evaluating) {
			throw new ReentrantDomainStateMachineEvaluationError();
		}

		this.#evaluating = true;
		try {
			return operation();
		} finally {
			this.#evaluating = false;
		}
	}
}
