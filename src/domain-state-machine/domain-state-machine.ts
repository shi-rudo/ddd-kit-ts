import { BaseError } from "@shirudo/base-error";
import { DomainError } from "../core/errors";
import {
	findPropertyDescriptor,
	isBuiltInObject,
	isIntrinsicConstructorPrototype,
} from "../utils/array/is-built-in";
import { deepFreeze } from "../value-object/value-object";

export type DomainMachineEvent = {
	readonly type: string;
};

/** Recursively readonly view of data accepted by the domain state machine. */
export type DomainMachineReadonly<TValue> = TValue extends
	| bigint
	| boolean
	| null
	| number
	| string
	| symbol
	| undefined
	? TValue
	: TValue extends (...args: never[]) => unknown
		? TValue
		: TValue extends readonly unknown[]
			? {
					readonly [TKey in keyof TValue]: DomainMachineReadonly<TValue[TKey]>;
				}
			: TValue extends object
				? {
						readonly [TKey in keyof TValue]: DomainMachineReadonly<
							TValue[TKey]
						>;
					}
				: TValue;

export type DomainMachineSnapshot<TState extends string, TContext> = {
	readonly state: TState;
	readonly context: DomainMachineReadonly<TContext>;
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
	/** Must be synchronous, deterministic, and side-effect-free. */
	readonly guard?: (input: {
		readonly state: TState;
		readonly context: DomainMachineReadonly<TContext>;
		readonly event: DomainMachineReadonly<TEvent>;
	}) => boolean;
	/** Must be synchronous, deterministic, and side-effect-free. */
	readonly reduce?: (input: {
		readonly state: TState;
		readonly context: DomainMachineReadonly<TContext>;
		readonly event: DomainMachineReadonly<TEvent>;
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
	/** Must be synchronous, deterministic, and side-effect-free. */
	readonly validateSnapshot?: (
		snapshot: DomainMachineSnapshot<TState, TContext>,
	) => boolean;
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
	readonly outputs: readonly DomainMachineReadonly<TOutput>[];
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

export class InvalidDomainTransitionGuardResultError extends BaseError<"InvalidDomainTransitionGuardResultError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainTransitionGuardResultError" });
	}
}

export class InvalidDomainTransitionResultError extends BaseError<"InvalidDomainTransitionResultError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainTransitionResultError" });
	}
}

export class ReentrantDomainStateMachineEvaluationError extends BaseError<"ReentrantDomainStateMachineEvaluationError"> {
	constructor() {
		super(
			"Domain state machine callbacks cannot evaluate the same machine.",
			undefined,
			{ name: "ReentrantDomainStateMachineEvaluationError" },
		);
	}
}

type DomainMachineDataErrorFactory = (
	message: string,
	cause?: unknown,
) =>
	| InvalidDomainMachineContextError
	| InvalidDomainMachineEventError
	| InvalidDomainTransitionResultError;

const DOMAIN_MACHINE_DATA_MAX_DEPTH = 256;
const DOMAIN_MACHINE_DATA_MAX_NODES = 10_000;
const DOMAIN_MACHINE_DATA_MAX_PROPERTIES = 100_000;

type DomainMachineDataTraversal = {
	nodes: number;
	properties: number;
};

const DOMAIN_MACHINE_DEFINITION_KEYS: ReadonlySet<PropertyKey> = new Set([
	"initial",
	"initialContext",
	"validateSnapshot",
	"states",
]);
const DOMAIN_MACHINE_STATE_NODE_KEYS: ReadonlySet<PropertyKey> = new Set([
	"terminal",
	"on",
]);
const DOMAIN_MACHINE_TRANSITION_KEYS: ReadonlySet<PropertyKey> = new Set([
	"target",
	"guard",
	"reduce",
]);
const DOMAIN_TRANSITION_RESULT_KEYS: ReadonlySet<PropertyKey> = new Set([
	"context",
	"outputs",
]);

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

function createInitialDomainMachineSnapshotFromPrepared<
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

function canTransitionPreparedDomainState<
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

function transitionPreparedDomainState<
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

function prepareDomainMachineSnapshot<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
): DomainMachineSnapshot<TState, TContext> {
	validateDomainMachineSnapshot(definition, snapshot);
	const preparedSnapshot = createDomainMachineSnapshot<TState, TContext>(
		snapshot,
	);
	validateDomainMachineSnapshotInvariant(definition, preparedSnapshot);
	return preparedSnapshot;
}

function createDomainMachineSnapshotFromPreparedContext<
	TState extends string,
	TContext,
>(
	state: TState,
	context: DomainMachineReadonly<TContext>,
): DomainMachineSnapshot<TState, TContext> {
	return Object.freeze({ state, context });
}

function createDomainMachineSnapshot<
	TState extends string,
	TContext,
>(snapshot: {
	readonly state: TState;
	readonly context: TContext | DomainMachineReadonly<TContext>;
}): DomainMachineSnapshot<TState, TContext> {
	return Object.freeze({
		state: readDomainMachineSnapshotState(snapshot),
		context: copyDomainMachineContext<TContext>(
			readDomainMachineSnapshotContext(snapshot),
		),
	}) as DomainMachineSnapshot<TState, TContext>;
}

function copyDomainMachineOutputs<TOutput>(
	outputs: readonly (TOutput | DomainMachineReadonly<TOutput>)[] | undefined,
): readonly DomainMachineReadonly<TOutput>[] {
	try {
		const copiedOutputs = cloneDomainMachineDataValue(
			outputs ?? [],
			createDomainTransitionOutputError,
		);
		return deepFreeze(
			copiedOutputs,
		) as readonly DomainMachineReadonly<TOutput>[];
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

function copyDomainMachineEvent<TEvent extends DomainMachineEvent>(
	event: TEvent,
): DomainMachineReadonly<TEvent> {
	try {
		return deepFreeze(
			cloneDomainMachineDataValue(event, createDomainMachineEventError),
		) as DomainMachineReadonly<TEvent>;
	} catch (cause) {
		if (cause instanceof InvalidDomainMachineEventError) {
			throw cause;
		}
		throw new InvalidDomainMachineEventError(
			"Domain machine event must contain cloneable, deeply immutable data.",
			cause,
		);
	}
}

function copyDomainMachineContext<TContext>(
	context: TContext | DomainMachineReadonly<TContext>,
): DomainMachineReadonly<TContext> {
	try {
		return deepFreeze(
			cloneDomainMachineDataValue(context, createDomainMachineContextError),
		) as DomainMachineReadonly<TContext>;
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

function createDomainMachineEventError(
	message: string,
	cause?: unknown,
): InvalidDomainMachineEventError {
	return new InvalidDomainMachineEventError(message, cause);
}

function createDomainTransitionOutputError(
	message: string,
	cause?: unknown,
): InvalidDomainTransitionResultError {
	return new InvalidDomainTransitionResultError(message, cause);
}

function cloneDomainMachineDataValue<TValue>(
	value: TValue,
	errorFactory: DomainMachineDataErrorFactory,
	seen = new WeakMap<object, unknown>(),
	traversal: DomainMachineDataTraversal = { nodes: 0, properties: 0 },
	depth = 0,
): TValue {
	if (typeof value === "function") {
		throw errorFactory("Domain machine data cannot contain function values.");
	}
	if (value === null || typeof value !== "object") return value;

	const source = value as object;
	if (depth > DOMAIN_MACHINE_DATA_MAX_DEPTH) {
		throw errorFactory(
			`Domain machine data exceeds the maximum depth of ${DOMAIN_MACHINE_DATA_MAX_DEPTH}.`,
		);
	}
	const existing = seen.get(source);
	if (existing !== undefined) return existing as TValue;
	traversal.nodes += 1;
	if (traversal.nodes > DOMAIN_MACHINE_DATA_MAX_NODES) {
		throw errorFactory(
			`Domain machine data contains more than ${DOMAIN_MACHINE_DATA_MAX_NODES.toLocaleString("en-US")} object nodes.`,
		);
	}
	const toStringTagDescriptor = findPropertyDescriptor(
		source,
		Symbol.toStringTag,
	);
	if (
		toStringTagDescriptor !== undefined &&
		!("value" in toStringTagDescriptor)
	) {
		throw errorFactory(
			"Domain machine data cannot contain accessor properties.",
		);
	}

	if (Array.isArray(value)) {
		if (!isIntrinsicArrayPrototype(Object.getPrototypeOf(value))) {
			throw errorFactory(
				"Domain machine data cannot contain custom Array instances.",
			);
		}
		const cloned: unknown[] = new Array(value.length);
		seen.set(source, cloned);

		for (const key of readDomainMachineDataKeys(
			source,
			errorFactory,
			traversal,
		)) {
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (!descriptor) continue;

			if (!("value" in descriptor)) {
				throw errorFactory(
					"Domain machine data cannot contain accessor properties.",
				);
			}

			if (key === "length") continue;

			descriptor.value = cloneDomainMachineDataValue(
				descriptor.value,
				errorFactory,
				seen,
				traversal,
				depth + 1,
			);
			Object.defineProperty(cloned, key, descriptor);
		}
		return cloned as TValue;
	}

	const prototype = Object.getPrototypeOf(source);
	if (prototype !== null && !isIntrinsicObjectPrototype(prototype)) {
		throw errorFactory(
			"Domain machine data cannot contain custom class instances.",
		);
	}

	const tag = Object.prototype.toString.call(source);
	if (isBuiltInObject(source, tag) || ArrayBuffer.isView(source)) {
		throw errorFactory(
			`Domain machine data cannot contain ${tag.slice(8, -1)} object values.`,
		);
	}

	const cloned = Object.create(prototype === null ? null : Object.prototype);
	seen.set(source, cloned);

	for (const key of readDomainMachineDataKeys(
		source,
		errorFactory,
		traversal,
	)) {
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
			traversal,
			depth + 1,
		);
		Object.defineProperty(cloned, key, descriptor);
	}

	return cloned as TValue;
}

function readDomainMachineDataKeys(
	value: object,
	errorFactory: DomainMachineDataErrorFactory,
	traversal: DomainMachineDataTraversal,
): readonly PropertyKey[] {
	const keys = Reflect.ownKeys(value);
	traversal.properties += keys.length;
	if (traversal.properties > DOMAIN_MACHINE_DATA_MAX_PROPERTIES) {
		throw errorFactory(
			`Domain machine data contains more than ${DOMAIN_MACHINE_DATA_MAX_PROPERTIES.toLocaleString("en-US")} own properties.`,
		);
	}
	return keys;
}

function copyDomainMachineDefinition<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
): DomainMachineDefinition<TState, TContext, TEvent, TOutput> {
	const states = readDomainMachineDefinitionProperty(
		definition,
		"states",
	) as DomainMachineDefinition<TState, TContext, TEvent, TOutput>["states"];
	const copiedStates = Object.create(null) as {
		[TName in TState]: DomainStateNode<TState, TContext, TEvent, TOutput>;
	};

	for (const state of Object.keys(states) as TState[]) {
		const node = readDomainMachineDefinitionProperty(
			states,
			state,
		) as DomainStateNode<TState, TContext, TEvent, TOutput>;
		const transitions = readOptionalDomainMachineDefinitionProperty(
			node,
			"on",
		) as DomainStateNode<TState, TContext, TEvent, TOutput>["on"] | undefined;
		const copiedTransitions = Object.create(null) as {
			[TType in TEvent["type"]]?: DomainTransition<
				TState,
				TContext,
				Extract<TEvent, { readonly type: TType }>,
				TOutput
			>;
		};

		for (const eventType of Object.keys(
			transitions ?? {},
		) as TEvent["type"][]) {
			const transition = readDomainMachineDefinitionProperty(
				transitions as object,
				eventType,
			) as
				| DomainTransition<
						TState,
						TContext,
						Extract<TEvent, { readonly type: typeof eventType }>,
						TOutput
				  >
				| undefined;
			if (transition) {
				const copiedTransition = Object.freeze({
					target: readDomainMachineDefinitionProperty(transition, "target"),
					guard: readOptionalDomainMachineDefinitionProperty(
						transition,
						"guard",
					),
					reduce: readOptionalDomainMachineDefinitionProperty(
						transition,
						"reduce",
					),
				}) as DomainTransition<
					TState,
					TContext,
					Extract<TEvent, { readonly type: typeof eventType }>,
					TOutput
				>;
				Object.defineProperty(copiedTransitions, eventType, {
					value: copiedTransition,
					enumerable: true,
				});
			}
		}

		Object.defineProperty(copiedStates, state, {
			value: Object.freeze({
				terminal: readOptionalDomainMachineDefinitionProperty(node, "terminal"),
				on: Object.freeze(copiedTransitions),
			}),
			enumerable: true,
		});
	}

	return Object.freeze({
		initial: readDomainMachineDefinitionProperty(
			definition,
			"initial",
		) as TState,
		initialContext: readDomainMachineDefinitionProperty(
			definition,
			"initialContext",
		) as () => TContext,
		validateSnapshot: readOptionalDomainMachineDefinitionProperty(
			definition,
			"validateSnapshot",
		) as
			| ((snapshot: DomainMachineSnapshot<TState, TContext>) => boolean)
			| undefined,
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
	if (!isPlainRecord(candidate)) {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine definition must be a plain object.",
		);
	}
	assertDomainMachineDefinitionDataProperties(
		candidate,
		DOMAIN_MACHINE_DEFINITION_KEYS,
	);

	const initial = readDomainMachineDefinitionProperty(candidate, "initial");
	if (typeof initial !== "string") {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine initial state must be a string data property.",
		);
	}

	if (
		typeof readDomainMachineDefinitionProperty(candidate, "initialContext") !==
		"function"
	) {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine initialContext must be a function data property.",
		);
	}

	const validateSnapshot = readOptionalDomainMachineDefinitionProperty(
		candidate,
		"validateSnapshot",
	);
	if (
		validateSnapshot !== undefined &&
		typeof validateSnapshot !== "function"
	) {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine validateSnapshot must be a function data property.",
		);
	}

	const statesCandidate = readDomainMachineDefinitionProperty(
		candidate,
		"states",
	);
	if (!isPlainRecord(statesCandidate)) {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine states must be a plain object data property.",
		);
	}
	const states: Record<PropertyKey, unknown> = statesCandidate;
	assertDomainMachineDefinitionEntryMap(states, "state");

	if (!hasOwn(states, initial)) {
		throw new InvalidDomainMachineDefinitionError(
			`Initial domain machine state "${initial}" is not defined.`,
		);
	}

	for (const state of Object.keys(states)) {
		const node: unknown = readDomainMachineDefinitionProperty(states, state);
		if (!isPlainRecord(node)) {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine state "${state}" must be a plain object data property.`,
			);
		}
		assertDomainMachineDefinitionDataProperties(
			node,
			DOMAIN_MACHINE_STATE_NODE_KEYS,
		);

		const terminal: unknown = readOptionalDomainMachineDefinitionProperty(
			node,
			"terminal",
		);
		if (terminal !== undefined && typeof terminal !== "boolean") {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine state "${state}" terminal flag must be a boolean.`,
			);
		}

		const transitions: unknown = readOptionalDomainMachineDefinitionProperty(
			node,
			"on",
		);
		if (transitions !== undefined && !isPlainRecord(transitions)) {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine state "${state}" transitions must be a plain object.`,
			);
		}
		if (isPlainRecord(transitions)) {
			assertDomainMachineDefinitionEntryMap(transitions, "event");
		}

		const eventTypes = Object.keys(transitions ?? {});
		if (terminal === true && eventTypes.length > 0) {
			throw new InvalidDomainMachineDefinitionError(
				`Terminal domain machine state "${state}" cannot declare transitions.`,
			);
		}

		for (const eventType of eventTypes) {
			const transition: unknown = readDomainMachineDefinitionProperty(
				transitions as object,
				eventType,
			);
			if (!isPlainRecord(transition)) {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" must be a plain object.`,
				);
			}
			assertDomainMachineDefinitionDataProperties(
				transition,
				DOMAIN_MACHINE_TRANSITION_KEYS,
			);

			const target: unknown = readDomainMachineDefinitionProperty(
				transition,
				"target",
			);
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

			const guard: unknown = readOptionalDomainMachineDefinitionProperty(
				transition,
				"guard",
			);
			if (guard !== undefined && typeof guard !== "function") {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" guard must be a function.`,
				);
			}

			const reduce: unknown = readOptionalDomainMachineDefinitionProperty(
				transition,
				"reduce",
			);
			if (reduce !== undefined && typeof reduce !== "function") {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${eventType}" reduce must be a function.`,
				);
			}
		}
	}
}

function assertDomainMachineDefinitionDataProperties(
	value: object,
	allowedKeys?: ReadonlySet<PropertyKey>,
): void {
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor !== undefined && !("value" in descriptor)) {
			throw new InvalidDomainMachineDefinitionError(
				"Domain machine definition must contain data properties only.",
			);
		}
		if (allowedKeys !== undefined && !allowedKeys.has(key)) {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine definition contains unknown property "${String(key)}".`,
			);
		}
	}
}

function assertDomainMachineDefinitionEntryMap(
	value: object,
	entryName: "state" | "event",
): void {
	assertDomainMachineDefinitionDataProperties(value);

	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || descriptor?.enumerable !== true) {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine ${entryName} names must be enumerable string properties.`,
			);
		}
	}
}

function readDomainMachineDefinitionProperty(
	value: object,
	key: PropertyKey,
): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor === undefined || !("value" in descriptor)) {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine definition must contain data properties only.",
		);
	}

	return descriptor.value;
}

function readOptionalDomainMachineDefinitionProperty(
	value: object,
	key: PropertyKey,
): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor === undefined) return undefined;
	if (!("value" in descriptor)) {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine definition must contain data properties only.",
		);
	}

	return descriptor.value;
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

	const state = readDomainMachineSnapshotState(snapshot);
	readDomainMachineSnapshotContext(snapshot);

	if (!hasOwn(definition.states, state)) {
		throw new InvalidDomainMachineSnapshotError(
			`Domain machine snapshot state "${state}" is not defined.`,
		);
	}
}

function validateDomainMachineSnapshotInvariant<
	TState extends string,
	TContext,
	TEvent extends DomainMachineEvent,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TEvent, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
): void {
	if (definition.validateSnapshot === undefined) return;

	const valid = definition.validateSnapshot(snapshot);
	if (typeof valid !== "boolean") {
		throw new InvalidDomainMachineDefinitionError(
			"Domain machine validateSnapshot must return a boolean.",
		);
	}

	if (!valid) {
		throw new InvalidDomainMachineSnapshotError(
			`Domain machine snapshot violates invariants for state "${snapshot.state}".`,
		);
	}
}

function readDomainMachineSnapshotState<TState extends string>(snapshot: {
	readonly state: TState;
}): TState {
	const stateDescriptor = Object.getOwnPropertyDescriptor(snapshot, "state");
	if (
		stateDescriptor === undefined ||
		!("value" in stateDescriptor) ||
		typeof stateDescriptor.value !== "string"
	) {
		throw new InvalidDomainMachineSnapshotError(
			"Domain machine snapshot state must be a string data property.",
		);
	}

	return stateDescriptor.value as TState;
}

function readDomainMachineSnapshotContext<TContext>(snapshot: {
	readonly context: TContext;
}): TContext {
	const contextDescriptor = Object.getOwnPropertyDescriptor(
		snapshot,
		"context",
	);
	if (contextDescriptor === undefined || !("value" in contextDescriptor)) {
		throw new InvalidDomainMachineSnapshotError(
			"Domain machine snapshot context must be present as a data property.",
		);
	}

	return contextDescriptor.value as TContext;
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
	if (!isRecord(event)) return false;

	const typeDescriptor = Object.getOwnPropertyDescriptor(event, "type");
	return (
		typeDescriptor !== undefined &&
		"value" in typeDescriptor &&
		typeof typeDescriptor.value === "string"
	);
}

function validateDomainTransitionGuardResult(
	result: unknown,
): asserts result is boolean {
	if (typeof result !== "boolean") {
		throw new InvalidDomainTransitionGuardResultError(
			"Domain transition guard must return a boolean.",
		);
	}
}

function validateDomainTransitionResult<TContext, TOutput>(
	result: DomainTransitionResult<TContext, TOutput> | undefined,
): void {
	if (result === undefined) return;

	if (!isPlainRecord(result)) {
		throw new InvalidDomainTransitionResultError(
			"Domain transition result must be a plain object when returned.",
		);
	}

	for (const key of Reflect.ownKeys(result)) {
		if (!DOMAIN_TRANSITION_RESULT_KEYS.has(key)) {
			throw new InvalidDomainTransitionResultError(
				`Domain transition result contains unknown property "${String(key)}".`,
			);
		}
		const descriptor = Object.getOwnPropertyDescriptor(result, key);
		if (descriptor !== undefined && !("value" in descriptor)) {
			throw new InvalidDomainTransitionResultError(
				"Domain transition result must contain data properties only.",
			);
		}
	}

	const outputs = readDomainTransitionResultOutputs(result);
	if (outputs !== undefined && !Array.isArray(outputs)) {
		throw new InvalidDomainTransitionResultError(
			"Domain transition result outputs must be an array when provided.",
		);
	}
}

function readDomainTransitionResultContext<TContext, TOutput>(
	result: DomainTransitionResult<TContext, TOutput> | undefined,
):
	| { readonly hasContext: false }
	| { readonly hasContext: true; readonly context: TContext } {
	if (result === undefined) return { hasContext: false };

	const contextDescriptor = Object.getOwnPropertyDescriptor(result, "context");
	if (contextDescriptor === undefined) return { hasContext: false };
	if (!("value" in contextDescriptor)) {
		throw new InvalidDomainTransitionResultError(
			"Domain transition result context must be a data property when provided.",
		);
	}

	return { hasContext: true, context: contextDescriptor.value as TContext };
}

function readDomainTransitionResultOutputs<TContext, TOutput>(
	result: DomainTransitionResult<TContext, TOutput> | undefined,
): readonly TOutput[] | undefined {
	if (result === undefined) return undefined;

	const outputsDescriptor = Object.getOwnPropertyDescriptor(result, "outputs");
	if (outputsDescriptor === undefined) return undefined;
	if (!("value" in outputsDescriptor)) {
		throw new InvalidDomainTransitionResultError(
			"Domain transition result outputs must be a data property when provided.",
		);
	}

	return outputsDescriptor.value as readonly TOutput[] | undefined;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<PropertyKey, unknown> {
	if (!isRecord(value)) return false;

	const prototype = Object.getPrototypeOf(value);
	return prototype === null || isIntrinsicObjectPrototype(prototype);
}

function isIntrinsicArrayPrototype(prototype: object | null): boolean {
	if (prototype === null || !Array.isArray(prototype)) return false;
	if (!isIntrinsicConstructorPrototype(prototype, "Array")) return false;

	const parentPrototype = Object.getPrototypeOf(prototype);
	return (
		parentPrototype !== null && isIntrinsicObjectPrototype(parentPrototype)
	);
}

function isIntrinsicObjectPrototype(prototype: object): boolean {
	return (
		Object.getPrototypeOf(prototype) === null &&
		isIntrinsicConstructorPrototype(prototype, "Object")
	);
}

function hasOwn<T extends object>(value: T, key: PropertyKey): key is keyof T {
	return Object.hasOwn(value, key);
}
