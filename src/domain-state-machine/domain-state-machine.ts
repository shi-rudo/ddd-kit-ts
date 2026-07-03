import type {
	DomainMachineDefinition,
	DomainMachineEvent,
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
	DomainMachineDefinition,
	DomainMachineEvent,
	DomainMachineReadonly,
	DomainMachineSnapshot,
	DomainStateNode,
	DomainTransition,
	DomainTransitionOutcome,
	DomainTransitionResult,
} from "./contracts";
export {
	DomainTransitionGuardRejectedError,
	InvalidDomainMachineContextError,
	InvalidDomainMachineDefinitionError,
	InvalidDomainMachineEventError,
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

export class DomainStateMachine<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput = never,
> {
	private readonly definition: DomainMachineDefinition<
		TState,
		TContext,
		TEvent,
		TOutput
	>;

	#snapshot: DomainMachineSnapshot<TState, TContext>;
	#evaluating = false;

	constructor(
		definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	);
	constructor(
		definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
		snapshot: DomainMachineSnapshot<TState, TContext>,
	);
	constructor(
		definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
		...snapshotInput: [] | [DomainMachineSnapshot<TState, TContext> | undefined]
	) {
		validateDomainMachineDefinition(definition);
		this.definition = copyDomainMachineDefinition(definition);
		if (snapshotInput.length === 1) {
			const [snapshot] = snapshotInput;
			const suppliedSnapshot = snapshot as DomainMachineSnapshot<
				TState,
				TContext
			>;
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

	get snapshot(): DomainMachineSnapshot<TState, TContext> {
		return createDomainMachineSnapshot<TState, TContext>(this.#snapshot);
	}

	get state(): TState {
		return this.#snapshot.state;
	}

	get context(): DomainMachineReadonly<TContext> {
		return this.#snapshot.context;
	}

	isTerminal(): boolean {
		return this.definition.states[this.state].terminal === true;
	}

	can(event: TEvent): boolean {
		return this.evaluate(() =>
			canTransitionPreparedDomainState(this.definition, this.#snapshot, event),
		);
	}

	dispatch(event: TEvent): DomainTransitionOutcome<TState, TContext, TOutput> {
		return this.evaluate(() => {
			const result = transitionPreparedDomainState(
				this.definition,
				this.#snapshot,
				event,
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
