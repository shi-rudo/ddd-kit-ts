import {
	findPropertyDescriptor,
	isBuiltInObject,
	isIntrinsicConstructorPrototype,
} from "../utils/array/is-built-in";
import { deepFreeze } from "../value-object/value-object";
import type { DomainMachineInput, DomainMachineReadonly } from "./contracts";
import {
	InvalidDomainMachineContextError,
	InvalidDomainMachineInputError,
	InvalidDomainTransitionResultError,
} from "./errors";

type DomainMachineDataErrorFactory = (
	message: string,
	cause?: unknown,
) =>
	| InvalidDomainMachineContextError
	| InvalidDomainMachineInputError
	| InvalidDomainTransitionResultError;

const DOMAIN_MACHINE_DATA_MAX_DEPTH = 256;
const DOMAIN_MACHINE_DATA_MAX_NODES = 10_000;
const DOMAIN_MACHINE_DATA_MAX_PROPERTIES = 100_000;

type DomainMachineDataTraversal = {
	nodes: number;
	properties: number;
};

export function copyDomainMachineOutputs<TOutput>(
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

export function copyDomainMachineInput<TInput extends DomainMachineInput>(
	input: TInput,
): DomainMachineReadonly<TInput> {
	try {
		return deepFreeze(
			cloneDomainMachineDataValue(input, createDomainMachineInputError),
		) as DomainMachineReadonly<TInput>;
	} catch (cause) {
		if (cause instanceof InvalidDomainMachineInputError) {
			throw cause;
		}
		throw new InvalidDomainMachineInputError(
			"Domain machine input must contain cloneable, deeply immutable data.",
			cause,
		);
	}
}

export function copyDomainMachineContext<TContext>(
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

function createDomainMachineInputError(
	message: string,
	cause?: unknown,
): InvalidDomainMachineInputError {
	return new InvalidDomainMachineInputError(message, cause);
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

export function isRecord(
	value: unknown,
): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPlainRecord(
	value: unknown,
): value is Record<PropertyKey, unknown> {
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

export function hasOwn<T extends object>(
	value: T,
	key: PropertyKey,
): key is keyof T {
	return Object.hasOwn(value, key);
}
