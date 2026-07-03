import type {
	DomainMachineDefinition,
	DomainMachineEvent,
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

export function getTransition<
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

export function validateDomainMachineDefinition<
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
