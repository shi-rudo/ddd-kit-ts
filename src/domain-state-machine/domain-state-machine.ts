import { BaseError } from "@shirudo/base-error";
import { DomainError } from "../core/errors";

export type DomainMachineEvent = {
	readonly type: string;
};

export type DomainMachineSnapshot<TState extends string, TContext> = {
	readonly state: TState;
	readonly context: TContext;
};

export type DomainTransitionResult<TContext, TOutput> = {
	readonly context?: TContext;
	readonly outputs?: readonly TOutput[];
};

export type DomainTransition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
> = {
	readonly target: TState;
	readonly guard?: (input: {
		readonly state: TState;
		readonly context: Readonly<TContext>;
		readonly event: TEvent;
	}) => boolean;
	readonly reduce?: (input: {
		readonly state: TState;
		readonly context: Readonly<TContext>;
		readonly event: TEvent;
	}) => DomainTransitionResult<TContext, TOutput> | undefined;
};

export type DomainStateNode<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
> = {
	readonly terminal?: boolean;
	readonly on?: {
		readonly [TType in TEvent["type"]]?: DomainTransition<
			TState,
			TContext,
			Extract<TEvent, { readonly type: TType }>,
			TOutput
		>;
	};
};

export type DomainMachineDefinition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput = never,
> = {
	readonly initial: TState;
	readonly initialContext: () => TContext;
	readonly states: {
		readonly [TName in TState]: DomainStateNode<
			TState,
			TContext,
			TEvent,
			TOutput
		>;
	};
};

export type DomainTransitionOutcome<
	TState extends string,
	TContext,
	TOutput,
> = {
	readonly from: TState;
	readonly to: TState;
	readonly snapshot: DomainMachineSnapshot<TState, TContext>;
	readonly outputs: readonly TOutput[];
};

export class InvalidDomainTransitionError extends DomainError<"InvalidDomainTransitionError"> {
	constructor(
		public readonly state: string,
		public readonly eventType: string,
	) {
		super(`No domain transition from "${state}" on "${eventType}".`);
	}
}

export class DomainTransitionGuardRejectedError extends DomainError<"DomainTransitionGuardRejectedError"> {
	constructor(
		public readonly state: string,
		public readonly eventType: string,
	) {
		super(`Domain transition guard rejected "${eventType}" from "${state}".`);
	}
}

export class InvalidDomainMachineDefinitionError extends BaseError<"InvalidDomainMachineDefinitionError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineDefinitionError" });
	}
}

export class InvalidDomainMachineSnapshotError extends BaseError<"InvalidDomainMachineSnapshotError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineSnapshotError" });
	}
}

export function createInitialDomainMachineSnapshot<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
): DomainMachineSnapshot<TState, TContext> {
	validateDomainMachineDefinition(definition);
	return createDomainMachineSnapshot({
		state: definition.initial,
		context: definition.initialContext(),
	});
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
	validateDomainMachineSnapshot(definition, snapshot);

	const stateNode = definition.states[snapshot.state];
	if (stateNode.terminal === true) return false;

	const transition = getTransition(definition, snapshot.state, event);
	if (!transition) return false;

	return (
		transition.guard?.({
			state: snapshot.state,
			context: snapshot.context,
			event,
		}) ?? true
	);
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
	validateDomainMachineSnapshot(definition, snapshot);

	const from = snapshot.state;
	const stateNode = definition.states[from];
	const transition =
		stateNode.terminal === true
			? undefined
			: getTransition(definition, from, event);

	if (!transition) {
		throw new InvalidDomainTransitionError(from, event.type);
	}

	const allowed =
		transition.guard?.({
			state: from,
			context: snapshot.context,
			event,
		}) ?? true;

	if (!allowed) {
		throw new DomainTransitionGuardRejectedError(from, event.type);
	}

	const result = transition.reduce?.({
		state: from,
		context: snapshot.context,
		event,
	});
	const nextSnapshot = createDomainMachineSnapshot({
		state: transition.target,
		context: result?.context ?? snapshot.context,
	});

	return {
		from,
		to: transition.target,
		snapshot: nextSnapshot,
		outputs: copyDomainMachineOutputs(result?.outputs),
	};
}

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

	constructor(
		definition: DomainMachineDefinition<
			TState,
			TContext,
			TEvent,
			TOutput
		>,
		snapshot?: DomainMachineSnapshot<TState, TContext>,
	) {
		validateDomainMachineDefinition(definition);
		this.definition = copyDomainMachineDefinition(definition);
		this.#snapshot =
			snapshot !== undefined
				? createDomainMachineSnapshot(snapshot)
				: createInitialDomainMachineSnapshot(this.definition);
		validateDomainMachineSnapshot(this.definition, this.#snapshot);
	}

	get snapshot(): DomainMachineSnapshot<TState, TContext> {
		return createDomainMachineSnapshot(this.#snapshot);
	}

	get state(): TState {
		return this.#snapshot.state;
	}

	get context(): Readonly<TContext> {
		return this.#snapshot.context;
	}

	isTerminal(): boolean {
		return this.definition.states[this.state].terminal === true;
	}

	can(event: TEvent): boolean {
		return canTransitionDomainState(this.definition, this.#snapshot, event);
	}

	dispatch(event: TEvent): DomainTransitionOutcome<TState, TContext, TOutput> {
		const result = transitionDomainState(
			this.definition,
			this.#snapshot,
			event,
		);
		this.#snapshot = result.snapshot;
		return {
			...result,
			snapshot: createDomainMachineSnapshot(result.snapshot),
			outputs: copyDomainMachineOutputs(result.outputs),
		};
	}
}

function createDomainMachineSnapshot<TState extends string, TContext>(
	snapshot: DomainMachineSnapshot<TState, TContext>,
): DomainMachineSnapshot<TState, TContext> {
	return Object.freeze({
		state: snapshot.state,
		context: snapshot.context,
	});
}

function copyDomainMachineOutputs<TOutput>(
	outputs: readonly TOutput[] | undefined,
): readonly TOutput[] {
	return Object.freeze([...(outputs ?? [])]);
}

function copyDomainMachineDefinition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
): DomainMachineDefinition<TState, TContext, TEvent, TOutput> {
	const copiedStates = {} as {
		[TName in TState]: DomainStateNode<TState, TContext, TEvent, TOutput>;
	};

	for (const state of Object.keys(definition.states) as TState[]) {
		const node = definition.states[state];
		const copiedTransitions = {} as {
			[TType in TEvent["type"]]?: DomainTransition<
				TState,
				TContext,
				Extract<TEvent, { readonly type: TType }>,
				TOutput
			>;
		};

		for (const eventType of Object.keys(node.on ?? {}) as TEvent["type"][]) {
			const transition = node.on?.[eventType];
			if (transition) {
				copiedTransitions[eventType] = Object.freeze({ ...transition }) as
					| DomainTransition<
							TState,
							TContext,
							Extract<TEvent, { readonly type: typeof eventType }>,
							TOutput
					  >
					| undefined;
			}
		}

		copiedStates[state] = Object.freeze({
			terminal: node.terminal,
			on: Object.freeze(copiedTransitions),
		});
	}

	return Object.freeze({
		initial: definition.initial,
		initialContext: definition.initialContext,
		states: Object.freeze(copiedStates),
	});
}

function getTransition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	state: TState,
	event: TEvent,
): DomainTransition<TState, TContext, TEvent, TOutput> | undefined {
	const transitions = definition.states[state].on;
	if (!transitions || !hasOwn(transitions, event.type)) return undefined;

	return transitions[event.type as TEvent["type"]] as
		| DomainTransition<TState, TContext, TEvent, TOutput>
		| undefined;
}

function validateDomainMachineDefinition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
): void {
	if (!hasOwn(definition.states, definition.initial)) {
		throw new InvalidDomainMachineDefinitionError(
			`Initial domain machine state "${definition.initial}" is not defined.`,
		);
	}

	const states = definition.states;
	for (const state of Object.keys(states) as TState[]) {
		const transitions = (states[state].on ?? {}) as Partial<
			Record<string, DomainTransition<TState, TContext, TEvent, TOutput>>
		>;
		for (const eventType of Object.keys(transitions)) {
			const transition = transitions[eventType];
			if (transition && !hasOwn(states, transition.target)) {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" targets unknown state "${transition.target}".`,
				);
			}
		}
	}
}

function validateDomainMachineSnapshot<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
): void {
	if (!hasOwn(definition.states, snapshot.state)) {
		throw new InvalidDomainMachineSnapshotError(
			`Domain machine snapshot state "${snapshot.state}" is not defined.`,
		);
	}
}

function hasOwn<T extends object>(value: T, key: PropertyKey): key is keyof T {
	return Object.hasOwn(value, key);
}
