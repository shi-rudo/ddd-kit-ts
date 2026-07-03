import type {
	DomainMachineDefinition,
	DomainMachineInput,
	DomainMachineSnapshot,
	DomainTransitionOutcome,
} from "./contracts";
import {
	copyDomainMachineDefinition,
	getTransition,
	validateDomainMachineDefinition,
} from "./definition";
import {
	DomainTransitionGuardRejectedError,
	InvalidDomainTransitionError,
} from "./errors";
import {
	copyDomainMachineInput,
	copyDomainMachineOutputs,
} from "./machine-data";
import {
	createDomainMachineSnapshot,
	createDomainMachineSnapshotFromPreparedContext,
	isDomainMachineInput,
	prepareDomainMachineSnapshot,
	readDomainTransitionResultContext,
	readDomainTransitionResultOutputs,
	resolveDomainTransitionGuardResult,
	validateDomainMachineInput,
	validateDomainMachineSnapshotInvariant,
	validateDomainTransitionResult,
} from "./snapshot";

/** Creates and validates a fresh initial snapshot from a machine definition. */
export function createInitialDomainMachineSnapshot<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
): DomainMachineSnapshot<TState, TContext> {
	validateDomainMachineDefinition(definition);
	const stableDefinition = copyDomainMachineDefinition(definition);
	return createInitialDomainMachineSnapshotFromPrepared(stableDefinition);
}

export function createInitialDomainMachineSnapshotFromPrepared<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
): DomainMachineSnapshot<TState, TContext> {
	const snapshot = createDomainMachineSnapshot<TState, TContext>({
		state: definition.initial,
		context: definition.initialContext(),
	});
	validateDomainMachineSnapshotInvariant(definition, snapshot);
	return snapshot;
}

/**
 * Checks whether an input currently has an allowed transition.
 *
 * Returns `false` for missing transitions, terminal states, rejected guards,
 * and inputs without an own string `type` property. Invalid payload data for a
 * matching transition and broken guard code still throw structured errors.
 */
export function canTransitionDomainState<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
	input: TInput,
): boolean {
	validateDomainMachineDefinition(definition);
	const stableDefinition = copyDomainMachineDefinition(definition);
	const currentSnapshot = prepareDomainMachineSnapshot(
		stableDefinition,
		snapshot,
	);
	return canTransitionPreparedDomainState(
		stableDefinition,
		currentSnapshot,
		input,
	);
}

export function canTransitionPreparedDomainState<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
	input: TInput,
): boolean {
	if (!isDomainMachineInput(input)) return false;

	const stateNode = definition.states[snapshot.state];
	if (stateNode.terminal === true) return false;

	const transition = getTransition(definition, snapshot.state, input);
	if (!transition) return false;

	const currentInput = copyDomainMachineInput(input);
	if (!transition.guard) return true;

	const guardResult = transition.guard({
		state: snapshot.state,
		context: snapshot.context,
		input: currentInput,
	});

	return resolveDomainTransitionGuardResult(guardResult).allowed;
}

/**
 * Applies one input without mutating the input definition or snapshot.
 *
 * @throws {@link InvalidDomainTransitionError} when no transition is defined.
 * @throws {@link DomainTransitionGuardRejectedError} when its guard rejects.
 * @throws A concrete `DomainError` returned by a rejecting guard.
 */
export function transitionDomainState<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
	input: TInput,
): DomainTransitionOutcome<TState, TContext, TOutput> {
	validateDomainMachineDefinition(definition);
	const stableDefinition = copyDomainMachineDefinition(definition);
	const currentSnapshot = prepareDomainMachineSnapshot(
		stableDefinition,
		snapshot,
	);
	return transitionPreparedDomainState(
		stableDefinition,
		currentSnapshot,
		input,
	);
}

export function transitionPreparedDomainState<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
	input: TInput,
): DomainTransitionOutcome<TState, TContext, TOutput> {
	validateDomainMachineInput(input);

	const from = snapshot.state;
	const stateNode = definition.states[from];
	const transition =
		stateNode.terminal === true
			? undefined
			: getTransition(definition, from, input);

	if (!transition) {
		throw new InvalidDomainTransitionError(from, input.type);
	}

	const currentInput = copyDomainMachineInput(input);
	const guardResult =
		transition.guard === undefined
			? true
			: transition.guard({
					state: from,
					context: snapshot.context,
					input: currentInput,
				});
	const guardDecision = resolveDomainTransitionGuardResult(guardResult);

	if (!guardDecision.allowed) {
		if (guardDecision.rejection !== undefined) {
			throw guardDecision.rejection;
		}
		throw new DomainTransitionGuardRejectedError(from, currentInput.type);
	}

	const result = transition.reduce?.({
		state: from,
		context: snapshot.context,
		input: currentInput,
	});
	validateDomainTransitionResult(result);
	const contextResult = readDomainTransitionResultContext(result);
	const nextContext = contextResult.hasContext
		? contextResult.context
		: snapshot.context;
	const nextSnapshot =
		nextContext === snapshot.context
			? createDomainMachineSnapshotFromPreparedContext<TState, TContext>(
					transition.target,
					snapshot.context,
				)
			: createDomainMachineSnapshot<TState, TContext>({
					state: transition.target,
					context: nextContext,
				});
	validateDomainMachineSnapshotInvariant(definition, nextSnapshot);

	return {
		from,
		to: transition.target,
		snapshot: nextSnapshot,
		outputs: copyDomainMachineOutputs(
			readDomainTransitionResultOutputs(result),
		),
	};
}
