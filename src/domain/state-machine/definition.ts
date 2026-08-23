import type {
	DomainMachineDefinition,
	DomainMachineInput,
	DomainMachineSnapshot,
	DomainStateNode,
	DomainTransition,
} from "./contracts";
import { InvalidDomainMachineDefinitionError } from "./errors";
import { hasOwn, isPlainRecord } from "./machine-data";

const DOMAIN_MACHINE_DEFINITION_KEYS: ReadonlySet<PropertyKey> = new Set([
	"initial",
	"initialContext",
	"validateSnapshot",
	"states",
]);
const DOMAIN_MACHINE_STATE_NODE_KEYS: ReadonlySet<PropertyKey> = new Set([
	"terminal",
	"validateContext",
	"on",
]);
const DOMAIN_MACHINE_TRANSITION_KEYS: ReadonlySet<PropertyKey> = new Set([
	"target",
	"guard",
	"reduce",
]);

export function copyDomainMachineDefinition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
): DomainMachineDefinition<TState, TContext, TInput, TOutput> {
	const states = readDomainMachineDefinitionProperty(
		definition,
		"states",
	) as DomainMachineDefinition<TState, TContext, TInput, TOutput>["states"];
	const copiedStates = Object.create(null) as {
		[TName in TState]: DomainStateNode<TState, TContext, TInput, TOutput>;
	};

	for (const state of Object.keys(states) as TState[]) {
		const node = readDomainMachineDefinitionProperty(
			states,
			state,
		) as DomainStateNode<TState, TContext, TInput, TOutput>;
		const transitions = readOptionalDomainMachineDefinitionProperty(
			node,
			"on",
		) as DomainStateNode<TState, TContext, TInput, TOutput>["on"] | undefined;
		const copiedTransitions = Object.create(null) as {
			[TType in TInput["type"]]?: DomainTransition<
				TState,
				TContext,
				Extract<TInput, { readonly type: TType }>,
				TOutput
			>;
		};

		for (const inputType of Object.keys(
			transitions ?? {},
		) as TInput["type"][]) {
			const transition = readDomainMachineDefinitionProperty(
				transitions as object,
				inputType,
			) as
				| DomainTransition<
						TState,
						TContext,
						Extract<TInput, { readonly type: typeof inputType }>,
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
					Extract<TInput, { readonly type: typeof inputType }>,
					TOutput
				>;
				Object.defineProperty(copiedTransitions, inputType, {
					value: copiedTransition,
					enumerable: true,
				});
			}
		}

		Object.defineProperty(copiedStates, state, {
			value: Object.freeze({
				terminal: readOptionalDomainMachineDefinitionProperty(node, "terminal"),
				validateContext: readOptionalDomainMachineDefinitionProperty(
					node,
					"validateContext",
				),
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

/**
 * Registry of definitions produced by `prepareDomainMachineDefinition`:
 * validated, defensively copied, deeply frozen. The runtime membership
 * proof lives in this module-private WeakSet (the stable copies are
 * frozen and must stay pure data, so no runtime brand property); the
 * compile-time proof is the required type brand on
 * {@link PreparedDomainMachineDefinition}. Only
 * `prepareDomainMachineDefinition` below adds to the set, so membership
 * always implies validated + copied + frozen.
 */
const preparedDefinitions = new WeakSet<object>();

declare const preparedDefinitionBrand: unique symbol;

/**
 * A machine definition that `prepareDomainMachineDefinition` has
 * validated, defensively copied, and deeply frozen. Assignable wherever
 * a plain `DomainMachineDefinition` is accepted; the reverse does NOT
 * hold (the brand is required), so an API that demands a prepared
 * definition rejects raw ones at compile time. The pure functions and
 * the `DomainStateMachine` constructor recognize prepared definitions
 * at runtime and skip their per-call validate-and-copy.
 */
export type PreparedDomainMachineDefinition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput = never,
> = DomainMachineDefinition<TState, TContext, TInput, TOutput> & {
	readonly [preparedDefinitionBrand]: true;
};

/**
 * The entry-point normalization every pure function and the
 * `DomainStateMachine` constructor share: a prepared definition passes
 * through untouched (already validated, copied, frozen); anything else
 * pays the documented per-call validate-and-copy.
 */
export function ensureStableDomainMachineDefinition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
): DomainMachineDefinition<TState, TContext, TInput, TOutput> {
	if (preparedDefinitions.has(definition)) return definition;
	validateDomainMachineDefinition(definition);
	const stable = copyDomainMachineDefinition(definition);
	// Re-validate the COPY: a Proxy can legally answer the copy's reads
	// differently from validation's (TOCTOU), so the object that will
	// actually be dispatched against must itself pass validation. Costs a
	// second pass on the raw path only; prepared definitions skip all of
	// this.
	validateDomainMachineDefinition(stable);
	return stable;
}

/**
 * Validates and stabilizes a machine definition ONCE, for repeated use
 * with the pure functions. Without it, `transitionDomainState` and
 * `canTransitionDomainState` re-validate and defensively re-copy the
 * WHOLE definition on every call (the documented safety of the raw
 * path); on a hot dispatch path that is avoidable O(definition) work.
 * The `DomainStateMachine` class does the equivalent once in its
 * constructor; this export brings the same amortization to pure-API
 * users:
 *
 * ```ts
 * const prepared = prepareDomainMachineDefinition(orderLifecycle);
 * // per dispatch: no re-validation, no definition copy
 * const outcome = transitionDomainState(prepared, snapshot, input);
 * ```
 *
 * The returned definition is a deeply frozen copy, isolated from later
 * mutation of the input object. Preparing an already-prepared
 * definition returns it unchanged.
 */
export function prepareDomainMachineDefinition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
): PreparedDomainMachineDefinition<TState, TContext, TInput, TOutput> {
	const stable = ensureStableDomainMachineDefinition(definition);
	preparedDefinitions.add(stable);
	return stable as PreparedDomainMachineDefinition<
		TState,
		TContext,
		TInput,
		TOutput
	>;
}

export function getTransition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
	state: TState,
	input: TInput,
): DomainTransition<TState, TContext, TInput, TOutput> | undefined {
	const transitions = definition.states[state].on;
	if (!transitions || !hasOwn(transitions, input.type)) return undefined;

	return transitions[input.type as TInput["type"]] as
		| DomainTransition<TState, TContext, TInput, TOutput>
		| undefined;
}

export function validateDomainMachineDefinition<
	TState extends string,
	TContext,
	TInput extends DomainMachineInput,
	TOutput,
>(
	definition: DomainMachineDefinition<TState, TContext, TInput, TOutput>,
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

		const validateContext: unknown =
			readOptionalDomainMachineDefinitionProperty(node, "validateContext");
		if (
			validateContext !== undefined &&
			typeof validateContext !== "function"
		) {
			throw new InvalidDomainMachineDefinitionError(
				`Domain machine state "${state}" validateContext must be a function.`,
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
			assertDomainMachineDefinitionEntryMap(transitions, "input");
		}

		const inputTypes = Object.keys(transitions ?? {});
		if (terminal === true && inputTypes.length > 0) {
			throw new InvalidDomainMachineDefinitionError(
				`Terminal domain machine state "${state}" cannot declare transitions.`,
			);
		}

		for (const inputType of inputTypes) {
			const transition: unknown = readDomainMachineDefinitionProperty(
				transitions as object,
				inputType,
			);
			if (!isPlainRecord(transition)) {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${inputType}" must be a plain object.`,
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
					`Domain transition from "${state}" on "${inputType}" must target a string state.`,
				);
			}

			if (!hasOwn(states, target)) {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${inputType}" targets unknown state "${target}".`,
				);
			}

			const guard: unknown = readOptionalDomainMachineDefinitionProperty(
				transition,
				"guard",
			);
			if (guard !== undefined && typeof guard !== "function") {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${inputType}" guard must be a function.`,
				);
			}

			const reduce: unknown = readOptionalDomainMachineDefinitionProperty(
				transition,
				"reduce",
			);
			if (reduce !== undefined && typeof reduce !== "function") {
				throw new InvalidDomainMachineDefinitionError(
					`Domain transition from "${state}" on "${inputType}" reduce must be a function.`,
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
	entryName: "state" | "input",
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
