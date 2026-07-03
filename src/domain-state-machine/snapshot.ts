import { DomainError } from "../core/errors";
import type {
	DomainMachineDefinition,
	DomainMachineInput,
	DomainMachineReadonly,
	DomainMachineSnapshot,
	DomainTransitionResult,
} from "./contracts";
import {
	InvalidDomainMachineDefinitionError,
	InvalidDomainMachineInputError,
	InvalidDomainMachineSnapshotError,
	InvalidDomainTransitionGuardResultError,
	InvalidDomainTransitionResultError,
} from "./errors";
import {
	copyDomainMachineContext,
	hasOwn,
	isPlainRecord,
	isRecord,
} from "./machine-data";

const DOMAIN_TRANSITION_RESULT_KEYS: ReadonlySet<PropertyKey> = new Set([
	"context",
	"outputs",
]);

export function prepareDomainMachineSnapshot<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
): DomainMachineSnapshot<TState, TContext> {
	validateDomainMachineSnapshot(definition, snapshot);
	const preparedSnapshot = createDomainMachineSnapshot<TState, TContext>(
		snapshot,
	);
	validateDomainMachineSnapshotInvariant(definition, preparedSnapshot);
	return preparedSnapshot;
}

export function createDomainMachineSnapshotFromPreparedContext<
	TState extends string,
	TContext,
>(
	state: TState,
	context: DomainMachineReadonly<TContext>,
): DomainMachineSnapshot<TState, TContext> {
	return Object.freeze({ state, context });
}

export function createDomainMachineSnapshot<
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

export function validateDomainMachineSnapshot<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
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

export function validateDomainMachineSnapshotInvariant<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
	snapshot: DomainMachineSnapshot<TState, TContext>,
): void {
	const stateNode = definition.states[snapshot.state];
	if (stateNode.validateContext !== undefined) {
		const validContext = stateNode.validateContext({
			state: snapshot.state,
			context: snapshot.context,
		});
		if (typeof validContext !== "boolean") {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine state "${snapshot.state}" validateContext must return a boolean.`,
			);
		}
		if (!validContext) {
			throw new InvalidDomainMachineSnapshotError(
				`Domain machine snapshot violates the context invariant for state "${snapshot.state}".`,
			);
		}
	}

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

export function validateDomainMachineInput(
	input: unknown,
): asserts input is DomainMachineInput {
	if (!isDomainMachineInput(input)) {
		throw new InvalidDomainMachineInputError(
			"Domain machine input must be an object with a string type.",
		);
	}
}

export function isDomainMachineInput(
	input: unknown,
): input is DomainMachineInput {
	if (!isRecord(input)) return false;

	const typeDescriptor = Object.getOwnPropertyDescriptor(input, "type");
	return (
		typeDescriptor !== undefined &&
		"value" in typeDescriptor &&
		typeof typeDescriptor.value === "string"
	);
}

export function resolveDomainTransitionGuardResult(
	result: unknown,
):
	| { readonly allowed: true }
	| { readonly allowed: false; readonly rejection?: DomainError } {
	if (typeof result === "boolean") return { allowed: result };
	if (result instanceof DomainError) {
		return { allowed: false, rejection: result };
	}

	throw new InvalidDomainTransitionGuardResultError(
		"Domain transition guard must return a boolean or DomainError.",
	);
}

export function validateDomainTransitionResult<TContext, TOutput>(
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

export function readDomainTransitionResultContext<TContext, TOutput>(
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

export function readDomainTransitionResultOutputs<TContext, TOutput>(
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
