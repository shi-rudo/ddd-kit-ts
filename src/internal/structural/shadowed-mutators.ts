import {
	hasCooperativeBrand,
	stampCooperativeBrand,
} from "../cooperative-brand";
import { type BuiltInTag, builtInTypeName } from "./is-built-in";

/**
 * `Object.freeze` does not protect internal slots: a frozen Date still
 * accepts `setTime`, a frozen Map still accepts `set`. A deep freeze
 * therefore shadows these mutators with own throwing functions. The
 * shadows are non-enumerable, so they are invisible to `Object.keys` and
 * spread, and `structuredClone` drops them. A walk that checks a copy
 * accepts them as machinery, not data.
 */
const mutatorsByTag: ReadonlyMap<BuiltInTag, readonly string[]> = new Map<
	BuiltInTag,
	readonly string[]
>([
	[
		"[object Date]",
		[
			"setTime",
			"setMilliseconds",
			"setUTCMilliseconds",
			"setSeconds",
			"setUTCSeconds",
			"setMinutes",
			"setUTCMinutes",
			"setHours",
			"setUTCHours",
			"setDate",
			"setUTCDate",
			"setMonth",
			"setUTCMonth",
			"setFullYear",
			"setUTCFullYear",
			"setYear",
		],
	],
	["[object Map]", ["set", "delete", "clear"]],
	["[object Set]", ["add", "delete", "clear"]],
]);

// The brand marks a shadow without its name or its identity: a minifier
// can rename the function, and a second loaded copy of the kit has its
// own shadows.
const mutatorShadowBrand = Symbol.for("@shirudo/ddd-kit/mutator-shadow/v1");

// One shadow per type and mutator for the lifetime of the module: a deep
// freeze runs for every minted event, so a new closure per instance would
// be allocation churn on a hot path.
const shadows = new Map<string, () => never>();

function shadowOf(typeName: string, method: string): () => never {
	const key = `${typeName}.${method}`;
	let shadow = shadows.get(key);
	if (shadow === undefined) {
		shadow = function throwFrozenMutation(): never {
			throw new TypeError(
				`Cannot call ${method}() on a ${typeName} inside a deeply frozen value`,
			);
		};
		stampCooperativeBrand(shadow, mutatorShadowBrand);
		Object.freeze(shadow);
		shadows.set(key, shadow);
	}
	return shadow;
}

// Object.defineProperty reads the descriptor synchronously, so one mutable
// object serves every call.
const shadowDescriptor = {
	value: undefined as unknown,
	writable: false,
	enumerable: false,
	configurable: false,
};

/**
 * Installs the mutator shadows on a Date, a Map, or a Set whose tag is
 * `tag`. Returns whether it installed them: a built-in of another kind has
 * no mutator shadows, and a non-extensible one cannot take them.
 */
export function installMutatorShadows(
	object: object,
	tag: BuiltInTag,
): boolean {
	const mutators = mutatorsByTag.get(tag);
	if (mutators === undefined || !Object.isExtensible(object)) return false;
	const typeName = builtInTypeName(tag);
	for (const method of mutators) {
		shadowDescriptor.value = shadowOf(typeName, method);
		Object.defineProperty(object, method, shadowDescriptor);
	}
	return true;
}

/**
 * Whether the own property `key` of a built-in whose tag is `tag` is a
 * mutator shadow: a locked, non-enumerable function with the cooperative
 * brand of a shadow, under a mutator key of that built-in. The brand
 * catches accidents, not a forgery.
 */
export function isMutatorShadow(
	tag: BuiltInTag,
	key: string,
	descriptor: PropertyDescriptor,
): boolean {
	const shadow = descriptor.value;
	return (
		(mutatorsByTag.get(tag)?.includes(key) ?? false) &&
		typeof shadow === "function" &&
		descriptor.enumerable === false &&
		descriptor.writable === false &&
		descriptor.configurable === false &&
		hasCooperativeBrand(shadow, mutatorShadowBrand)
	);
}
