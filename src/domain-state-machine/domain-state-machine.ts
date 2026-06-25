import { BaseError } from "@shirudo/base-error";
import { DomainError } from "../core/errors";
import { isBuiltInObject } from "../utils/array/is-built-in";
import { deepFreeze } from "../value-object/value-object";

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

export class InvalidDomainMachineContextError extends BaseError<"InvalidDomainMachineContextError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineContextError" });
	}
}

export class InvalidDomainMachineSnapshotError extends BaseError<"InvalidDomainMachineSnapshotError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineSnapshotError" });
	}
}

export class InvalidDomainMachineEventError extends BaseError<"InvalidDomainMachineEventError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineEventError" });
	}
}

export class InvalidDomainTransitionResultError extends BaseError<"InvalidDomainTransitionResultError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainTransitionResultError" });
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
	if (!isDomainMachineEvent(event)) return false;

	const currentSnapshot = createDomainMachineSnapshot(snapshot);
	const stateNode = definition.states[currentSnapshot.state];
	if (stateNode.terminal === true) return false;

	const transition = getTransition(definition, currentSnapshot.state, event);
	if (!transition) return false;

	return (
		transition.guard?.({
			state: currentSnapshot.state,
			context: currentSnapshot.context,
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
	validateDomainMachineEvent(event);

	const currentSnapshot = createDomainMachineSnapshot(snapshot);
	const from = currentSnapshot.state;
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
			context: currentSnapshot.context,
			event,
		}) ?? true;

	if (!allowed) {
		throw new DomainTransitionGuardRejectedError(from, event.type);
	}

	const result = transition.reduce?.({
		state: from,
		context: currentSnapshot.context,
		event,
	});
	validateDomainTransitionResult(result);
	const nextContext =
		result !== undefined && hasOwn(result, "context")
			? (result as { readonly context: TContext }).context
			: currentSnapshot.context;
	const nextSnapshot = createDomainMachineSnapshot({
		state: transition.target,
		context: nextContext,
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
			this.#snapshot = createDomainMachineSnapshot(suppliedSnapshot);
		} else {
			this.#snapshot = createInitialDomainMachineSnapshot(this.definition);
		}
		validateDomainMachineSnapshot(this.definition, this.#snapshot);
	}

	get snapshot(): DomainMachineSnapshot<TState, TContext> {
		return createDomainMachineSnapshot(this.#snapshot);
	}

	get state(): TState {
		return this.#snapshot.state;
	}

	get context(): Readonly<TContext> {
		return copyDomainMachineContext(
			this.#snapshot.context,
		) as Readonly<TContext>;
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
		context: copyDomainMachineContext(snapshot.context),
	});
}

function copyDomainMachineOutputs<TOutput>(
	outputs: readonly TOutput[] | undefined,
): readonly TOutput[] {
	try {
		const copiedOutputs = (outputs ?? []).map((output) =>
			cloneDomainMachineDataValue(output, createDomainTransitionOutputError),
		);
		return deepFreeze(copiedOutputs) as readonly TOutput[];
	} catch (cause) {
		if (cause instanceof InvalidDomainTransitionResultError) {
			throw cause;
		}
		throw new InvalidDomainTransitionResultError(
			"Domain transition result outputs must contain cloneable, deeply immutable data.",
			cause,
		);
	}
}

function copyDomainMachineContext<TContext>(context: TContext): TContext {
	try {
		return deepFreeze(
			cloneDomainMachineDataValue(context, createDomainMachineContextError),
		) as TContext;
	} catch (cause) {
		if (cause instanceof InvalidDomainMachineContextError) {
			throw cause;
		}
		throw new InvalidDomainMachineContextError(
			"Domain machine context must contain cloneable, deeply immutable data.",
			cause,
		);
	}
}

function createDomainMachineContextError(
	message: string,
	cause?: unknown,
): InvalidDomainMachineContextError {
	return new InvalidDomainMachineContextError(message, cause);
}

function createDomainTransitionOutputError(
	message: string,
	cause?: unknown,
): InvalidDomainTransitionResultError {
	return new InvalidDomainTransitionResultError(message, cause);
}

function cloneDomainMachineDataValue<TValue>(
	value: TValue,
	errorFactory: (
		message: string,
		cause?: unknown,
	) => InvalidDomainMachineContextError | InvalidDomainTransitionResultError,
	seen = new WeakMap<object, unknown>(),
): TValue {
	if (typeof value === "function") {
		throw errorFactory("Domain machine data cannot contain function values.");
	}
	if (value === null || typeof value !== "object") return value;

	const source = value as object;
	const existing = seen.get(source);
	if (existing !== undefined) return existing as TValue;

	if (Array.isArray(value)) {
		const cloned: unknown[] = new Array(value.length);
		seen.set(source, cloned);
		for (let index = 0; index < value.length; index++) {
			cloned[index] = cloneDomainMachineDataValue(
				value[index],
				errorFactory,
				seen,
			);
		}
		return cloned as TValue;
	}

	const tag = Object.prototype.toString.call(source);
	if (isBuiltInObject(source, tag)) {
		if (
			tag === "[object ArrayBuffer]" ||
			tag === "[object SharedArrayBuffer]" ||
			ArrayBuffer.isView(source)
		) {
			throw errorFactory(
				"Domain machine data cannot contain ArrayBuffer or ArrayBuffer view values.",
			);
		}
		if (
			tag === "[object Promise]" ||
			tag === "[object WeakMap]" ||
			tag === "[object WeakSet]"
		) {
			throw errorFactory(
				`Domain machine data cannot contain ${tag.slice(8, -1)} values.`,
			);
		}
		if (tag !== "[object Map]" && tag !== "[object Set]") {
			const cloned = structuredClone(value);
			seen.set(source, cloned);
			return cloned;
		}
	}

	if (isBuiltInObject(source, tag) && tag === "[object Map]") {
		const cloned = new Map<unknown, unknown>();
		seen.set(source, cloned);
		for (const [key, entryValue] of source as Map<unknown, unknown>) {
			cloned.set(
				cloneDomainMachineDataValue(key, errorFactory, seen),
				cloneDomainMachineDataValue(entryValue, errorFactory, seen),
			);
		}
		return cloned as TValue;
	}

	if (isBuiltInObject(source, tag) && tag === "[object Set]") {
		const cloned = new Set<unknown>();
		seen.set(source, cloned);
		for (const entryValue of source as Set<unknown>) {
			cloned.add(cloneDomainMachineDataValue(entryValue, errorFactory, seen));
		}
		return cloned as TValue;
	}

	const cloned = Object.create(Object.getPrototypeOf(source));
	seen.set(source, cloned);

	for (const key of Reflect.ownKeys(source)) {
		const descriptor = Object.getOwnPropertyDescriptor(source, key);
		if (!descriptor) continue;

		if (!("value" in descriptor)) {
			throw errorFactory(
				"Domain machine data cannot contain accessor properties.",
			);
		}

		descriptor.value = cloneDomainMachineDataValue(
			descriptor.value,
			errorFactory,
			seen,
		);
		Object.defineProperty(cloned, key, descriptor);
	}

	return cloned as TValue;
}

function copyDomainMachineDefinition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
): DomainMachineDefinition<TState, TContext, TEvent, TOutput> {
	const copiedStates = Object.create(null) as {
		[TName in TState]: DomainStateNode<TState, TContext, TEvent, TOutput>;
	};

	for (const state of Object.keys(definition.states) as TState[]) {
		const node = definition.states[state];
		const copiedTransitions = Object.create(null) as {
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
				Object.defineProperty(copiedTransitions, eventType, {
					value: Object.freeze({ ...transition }) as DomainTransition<
						TState,
						TContext,
						Extract<TEvent, { readonly type: typeof eventType }>,
						TOutput
					>,
					enumerable: true,
				});
			}
		}

		Object.defineProperty(copiedStates, state, {
			value: Object.freeze({
				terminal: node.terminal,
				on: Object.freeze(copiedTransitions),
			}),
			enumerable: true,
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
	const candidate = definition as unknown;
	if (!isRecord(candidate)) {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine definition must be an object.",
		);
	}

	const initial = candidate.initial;
	if (typeof initial !== "string") {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine initial state must be a string.",
		);
	}

	if (typeof candidate.initialContext !== "function") {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine initialContext must be a function.",
		);
	}

	const statesCandidate = candidate.states;
	if (!isRecord(statesCandidate)) {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine states must be an object.",
		);
	}
	const states: Record<PropertyKey, unknown> = statesCandidate;

	if (!hasOwn(states, initial)) {
		throw new InvalidDomainMachineDefinitionError(
			`Initial domain machine state "${initial}" is not defined.`,
		);
	}

	for (const state of Object.keys(states)) {
		const node: unknown = states[state];
		if (!isRecord(node)) {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine state "${state}" must be an object.`,
			);
		}

		const terminal: unknown = node.terminal;
		if (terminal !== undefined && typeof terminal !== "boolean") {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine state "${state}" terminal flag must be a boolean.`,
			);
		}

		const transitions: unknown = node.on;
		if (transitions !== undefined && !isRecord(transitions)) {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine state "${state}" transitions must be an object.`,
			);
		}

		for (const eventType of Object.keys(transitions ?? {})) {
			const transition: unknown = (transitions as Record<PropertyKey, unknown>)[
				eventType
			];
			if (!isRecord(transition)) {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" must be an object.`,
				);
			}

			const target: unknown = transition.target;
			if (typeof target !== "string") {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" must target a string state.`,
				);
			}

			if (!hasOwn(states, target)) {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" targets unknown state "${target}".`,
				);
			}

			const guard: unknown = transition.guard;
			if (guard !== undefined && typeof guard !== "function") {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" guard must be a function.`,
				);
			}

			const reduce: unknown = transition.reduce;
			if (reduce !== undefined && typeof reduce !== "function") {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" reduce must be a function.`,
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
	if (!isRecord(snapshot)) {
		throw new InvalidDomainMachineSnapshotError(
			"Domain machine snapshot must be an object.",
		);
	}

	if (typeof snapshot.state !== "string") {
		throw new InvalidDomainMachineSnapshotError(
			"Domain machine snapshot state must be a string.",
		);
	}

	if (!hasOwn(snapshot, "context")) {
		throw new InvalidDomainMachineSnapshotError(
			"Domain machine snapshot context must be present.",
		);
	}

	if (!hasOwn(definition.states, snapshot.state)) {
		throw new InvalidDomainMachineSnapshotError(
			`Domain machine snapshot state "${snapshot.state}" is not defined.`,
		);
	}
}

function validateDomainMachineEvent(
	event: unknown,
): asserts event is DomainMachineEvent {
	if (!isDomainMachineEvent(event)) {
		throw new InvalidDomainMachineEventError(
			"Domain machine event must be an object with a string type.",
		);
	}
}

function isDomainMachineEvent(event: unknown): event is DomainMachineEvent {
	return isRecord(event) && typeof event.type === "string";
}

function validateDomainTransitionResult<TContext, TOutput>(
	result: DomainTransitionResult<TContext, TOutput> | undefined,
): void {
	if (result === undefined) return;

	if (!isRecord(result)) {
		throw new InvalidDomainTransitionResultError(
			"Domain transition result must be an object when returned.",
		);
	}

	if (
		hasOwn(result, "outputs") &&
		result.outputs !== undefined &&
		!Array.isArray(result.outputs)
	) {
		throw new InvalidDomainTransitionResultError(
			"Domain transition result outputs must be an array when provided.",
		);
	}
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn<T extends object>(value: T, key: PropertyKey): key is keyof T {
	return Object.hasOwn(value, key);
}
