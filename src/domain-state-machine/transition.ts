import type {
	DomainMachineDefinition,
	DomainMachineEvent,
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
	copyDomainMachineEvent,
	copyDomainMachineOutputs,
} from "./machine-data";
import {
	createDomainMachineSnapshot,
	createDomainMachineSnapshotFromPreparedContext,
	isDomainMachineEvent,
	prepareDomainMachineSnapshot,
	readDomainTransitionResultContext,
	readDomainTransitionResultOutputs,
	validateDomainMachineEvent,
	validateDomainMachineSnapshotInvariant,
	validateDomainTransitionGuardResult,
	validateDomainTransitionResult,
} from "./snapshot";

export function createInitialDomainMachineSnapshot<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
): DomainMachineSnapshot<TState, TContext> {
	validateDomainMachineDefinition(definition);
	const stableDefinition = copyDomainMachineDefinition(definition);
	return createInitialDomainMachineSnapshotFromPrepared(stableDefinition);
}

export function createInitialDomainMachineSnapshotFromPrepared<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
): DomainMachineSnapshot<TState, TContext> {
	const snapshot = createDomainMachineSnapshot<TState, TContext>({
		state: definition.initial,
		context: definition.initialContext(),
	});
	validateDomainMachineSnapshotInvariant(definition, snapshot);
	return snapshot;
}

export function canTransitionDomainState<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
	event: TEvent,
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
		event,
	);
}

export function canTransitionPreparedDomainState<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
	event: TEvent,
): boolean {
	if (!isDomainMachineEvent(event)) return false;

	const stateNode = definition.states[snapshot.state];
	if (stateNode.terminal === true) return false;

	const transition = getTransition(definition, snapshot.state, event);
	if (!transition) return false;

	const currentEvent = copyDomainMachineEvent(event);
	if (!transition.guard) return true;

	const allowed = transition.guard({
		state: snapshot.state,
		context: snapshot.context,
		event: currentEvent,
	});
	validateDomainTransitionGuardResult(allowed);

	return allowed;
}

export function transitionDomainState<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
	event: TEvent,
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
		event,
	);
}

export function transitionPreparedDomainState<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
	event: TEvent,
): DomainTransitionOutcome<TState, TContext, TOutput> {
	validateDomainMachineEvent(event);

	const from = snapshot.state;
	const stateNode = definition.states[from];
	const transition =
		stateNode.terminal === true
			? undefined
			: getTransition(definition, from, event);

	if (!transition) {
		throw new InvalidDomainTransitionError(from, event.type);
	}

	const currentEvent = copyDomainMachineEvent(event);
	const allowed =
		transition.guard === undefined
			? true
			: transition.guard({
					state: from,
					context: snapshot.context,
					event: currentEvent,
				});
	validateDomainTransitionGuardResult(allowed);

	if (!allowed) {
		throw new DomainTransitionGuardRejectedError(from, currentEvent.type);
	}

	const result = transition.reduce?.({
		state: from,
		context: snapshot.context,
		event: currentEvent,
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
