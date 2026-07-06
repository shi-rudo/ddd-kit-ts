/**
 * Set of `Object.prototype.toString.call(x)` tags that the library treats
 * as built-in atomic types. Members of this set are compared/cloned by
 * reference (or with type-specific logic) rather than walked structurally.
 *
 * Detection is tag-based, since `Object.prototype.toString` gives the same
 * answer across realms (an iframe's `Date` has the same tag as the main
 * window's `Date`), and then brand-verified via internal-slot probes,
 * because `Symbol.toStringTag` lets any plain object claim a built-in tag.
 * The previous strategy also checked `globalThis[name] === constructor`
 * and a `proto !== Object.prototype` heuristic; both broke for cross-realm
 * objects and the latter additionally misclassified ordinary user classes
 * as built-ins.
 */
const BUILT_IN_TAGS: ReadonlySet<string> = new Set([
	"[object Date]",
	"[object RegExp]",
	"[object Map]",
	"[object Set]",
	"[object WeakMap]",
	"[object WeakSet]",
	"[object Promise]",
	"[object Error]",
	"[object Boolean]",
	"[object Number]",
	"[object String]",
	"[object BigInt]",
	"[object ArrayBuffer]",
	"[object SharedArrayBuffer]",
	"[object DataView]",
]);

// Intrinsic probes for brand verification. Each one reads an internal slot
// and throws a TypeError when `this` is not a genuine instance, the only
// check a plain object cannot spoof via `Symbol.toStringTag`. Captured once
// so a tampered prototype cannot redirect the probe later.
function intrinsicGetter(
	proto: object,
	prop: string,
): (this: unknown) => unknown {
	const get = Object.getOwnPropertyDescriptor(proto, prop)?.get;
	// Spec-guaranteed accessors on intrinsic prototypes: unreachable
	// unless the environment itself is broken.
	if (!get) throw new Error(`missing intrinsic getter for ${prop}`);
	return get;
}

const dateGetTime = Date.prototype.getTime;
const mapSizeGet = intrinsicGetter(Map.prototype, "size");
const setSizeGet = intrinsicGetter(Set.prototype, "size");
const weakMapHas = WeakMap.prototype.has;
const weakSetHas = WeakSet.prototype.has;
const dataViewByteLengthGet = intrinsicGetter(DataView.prototype, "byteLength");
const arrayBufferByteLengthGet = intrinsicGetter(
	ArrayBuffer.prototype,
	"byteLength",
);
const sharedArrayBufferByteLengthGet =
	typeof SharedArrayBuffer === "undefined"
		? undefined
		: intrinsicGetter(SharedArrayBuffer.prototype, "byteLength");
const regExpSourceGet = intrinsicGetter(RegExp.prototype, "source");
const booleanValueOf = Boolean.prototype.valueOf;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const bigIntValueOf = BigInt.prototype.valueOf;
const functionToString = Function.prototype.toString;
const PROBE_KEY = {};

const INTRINSIC_CONSTRUCTOR_NAMES = [
	"Object",
	"Array",
	"Date",
	"RegExp",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"Promise",
	"Error",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
	"AggregateError",
	"Boolean",
	"Number",
	"String",
	"BigInt",
	"ArrayBuffer",
	"SharedArrayBuffer",
	"DataView",
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
] as const;

const intrinsicConstructorSources: ReadonlyMap<string, string> = new Map(
	INTRINSIC_CONSTRUCTOR_NAMES.flatMap((name) => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
		const intrinsic = descriptor?.value;
		return typeof intrinsic === "function"
			? [[name, functionToString.call(intrinsic)] as const]
			: [];
	}),
);
const intrinsicConstructorSourceSet: ReadonlySet<string> = new Set(
	intrinsicConstructorSources.values(),
);
const ERROR_INTRINSIC_NAMES = [
	"Error",
	"EvalError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"TypeError",
	"URIError",
	"AggregateError",
] as const;

export function isIntrinsicConstructorPrototype(
	prototype: object,
	expectedName?: string,
): boolean {
	const constructorDescriptor = Object.getOwnPropertyDescriptor(
		prototype,
		"constructor",
	);
	const candidateConstructor = constructorDescriptor?.value;
	if (
		constructorDescriptor === undefined ||
		!("value" in constructorDescriptor) ||
		typeof candidateConstructor !== "function"
	) {
		return false;
	}

	let candidateSource: string;
	try {
		candidateSource = functionToString.call(candidateConstructor);
	} catch {
		return false;
	}
	const expectedSource =
		expectedName === undefined
			? undefined
			: intrinsicConstructorSources.get(expectedName);
	if (
		(expectedSource !== undefined && candidateSource !== expectedSource) ||
		(expectedSource === undefined &&
			!intrinsicConstructorSourceSet.has(candidateSource))
	) {
		return false;
	}

	const nameDescriptor = Object.getOwnPropertyDescriptor(
		candidateConstructor,
		"name",
	);
	const candidateName =
		nameDescriptor !== undefined &&
		"value" in nameDescriptor &&
		typeof nameDescriptor.value === "string"
			? nameDescriptor.value
			: undefined;
	const intrinsicName = expectedName ?? candidateName;
	const intrinsicSource =
		intrinsicName === undefined
			? undefined
			: intrinsicConstructorSources.get(intrinsicName);
	return (
		candidateName === intrinsicName &&
		intrinsicSource !== undefined &&
		candidateSource === intrinsicSource &&
		Object.getOwnPropertyDescriptor(candidateConstructor, "prototype")
			?.value === prototype
	);
}

/**
 * Accepts an intrinsic prototype, optionally behind transparent
 * `Symbol.toStringTag` override layers. A user-defined subclass has its own
 * non-native constructor and is therefore rejected before reaching the
 * intrinsic prototype.
 */
export function hasIntrinsicPrototypeChain(
	value: object,
	expectedName?: string,
): boolean {
	const visited = new WeakSet<object>();
	let prototype = Object.getPrototypeOf(value);

	while (prototype !== null && !visited.has(prototype)) {
		visited.add(prototype);
		if (Object.hasOwn(prototype, "constructor")) {
			return isIntrinsicConstructorPrototype(prototype, expectedName);
		}
		const ownKeys = Reflect.ownKeys(prototype);
		if (ownKeys.length !== 1 || ownKeys[0] !== Symbol.toStringTag) {
			return false;
		}
		prototype = Object.getPrototypeOf(prototype);
	}

	return false;
}

/**
 * Tags that `deepEqual` compares BY REFERENCE (its unhandled-built-in
 * fallback) and that `deepOmit` must therefore ALIAS rather than clone:
 * a clone would break `deepEqualExcept(x, x)` reflexivity. Single source
 * of truth so the two modules cannot drift: if `deepEqual` ever learns a
 * by-value comparison for one of these, remove it here and add a clone
 * case in `deepOmit`'s `cloneBuiltIn` in the same change.
 */
export const REFERENCE_COMPARED_TAGS: ReadonlySet<string> = new Set([
	"[object Error]",
	"[object ArrayBuffer]",
	"[object SharedArrayBuffer]",
	"[object Promise]",
	"[object WeakMap]",
	"[object WeakSet]",
]);

/**
 * Intrinsic tags of OPAQUE exotics: objects whose internal state no
 * structural walk can observe (boxed Symbols, generator objects,
 * WeakRefs, FinalizationRegistry handles). `deepEqual` compares them by
 * identity and `deepOmit` passes them through by reference; treating
 * them as (empty) plain objects would make ALL such exotics equal to
 * each other. Deliberately a curated INTRINSIC list, not "every unknown
 * tag": a user class exposing its own `Symbol.toStringTag` (e.g.
 * "Money") keeps structural comparison, and a plain object spoofing one
 * of these intrinsic tags gets the identity semantics of the thing it
 * claims to be.
 */
const OPAQUE_EXOTIC_TAGS: ReadonlySet<string> = new Set([
	"[object Symbol]",
	"[object Generator]",
	"[object AsyncGenerator]",
	"[object WeakRef]",
	"[object FinalizationRegistry]",
]);

/** True when `tag` names an opaque intrinsic; see {@link OPAQUE_EXOTIC_TAGS}. */
export function isOpaqueExoticTag(tag: string): boolean {
	return OPAQUE_EXOTIC_TAGS.has(tag);
}

export function findPropertyDescriptor(
	value: object,
	key: PropertyKey,
): PropertyDescriptor | undefined {
	const visited = new WeakSet<object>();
	let current: object | null = value;

	while (current !== null && !visited.has(current)) {
		visited.add(current);
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor !== undefined) return descriptor;
		current = Object.getPrototypeOf(current);
	}

	return undefined;
}

export function objectTagWithoutInvokingAccessors(value: object): string {
	const descriptor = findPropertyDescriptor(value, Symbol.toStringTag);
	return descriptor !== undefined && !("value" in descriptor)
		? "[object Object]"
		: Object.prototype.toString.call(value);
}

export type MutableBuiltInTag =
	| "[object Date]"
	| "[object Map]"
	| "[object Set]";

export function builtInTagWithoutInvokingAccessors(
	value: object,
): string | undefined {
	if (ArrayBuffer.isView(value)) {
		return hasBrand(value, "[object DataView]")
			? "[object DataView]"
			: "[object TypedArray]";
	}

	const descriptor = findPropertyDescriptor(value, Symbol.toStringTag);
	if (descriptor !== undefined && !("value" in descriptor)) {
		return builtInTagFromBrand(value);
	}

	const tag = Object.prototype.toString.call(value);
	if (BUILT_IN_TAGS.has(tag) && hasBrand(value, tag)) {
		return tag;
	}
	return descriptor === undefined ? undefined : builtInTagFromBrand(value);
}

export function mutableBuiltInTagWithoutInvokingAccessors(
	value: object,
): MutableBuiltInTag | undefined {
	const tag = builtInTagWithoutInvokingAccessors(value);
	return tag === "[object Date]" ||
		tag === "[object Map]" ||
		tag === "[object Set]"
		? tag
		: undefined;
}

function builtInTagFromBrand(value: object): string | undefined {
	if (hasBrand(value, "[object Date]")) return "[object Date]";
	if (hasBrand(value, "[object RegExp]")) return "[object RegExp]";
	if (hasBrand(value, "[object Map]")) return "[object Map]";
	if (hasBrand(value, "[object Set]")) return "[object Set]";
	if (hasBrand(value, "[object WeakMap]")) return "[object WeakMap]";
	if (hasBrand(value, "[object WeakSet]")) return "[object WeakSet]";
	if (hasBrand(value, "[object DataView]")) return "[object DataView]";
	if (hasBrand(value, "[object ArrayBuffer]")) return "[object ArrayBuffer]";
	if (hasBrand(value, "[object SharedArrayBuffer]")) {
		return "[object SharedArrayBuffer]";
	}
	if (hasBrand(value, "[object Boolean]")) return "[object Boolean]";
	if (hasBrand(value, "[object Number]")) return "[object Number]";
	if (hasBrand(value, "[object String]")) return "[object String]";
	if (hasBrand(value, "[object BigInt]")) return "[object BigInt]";
	if (hasNativePrototype(value, "Promise")) return "[object Promise]";
	if (hasNativePrototype(value, "Error")) return "[object Error]";
	return undefined;
}

function hasNativePrototype(value: object, expectedName: string): boolean {
	const visited = new WeakSet<object>();
	let prototype = Object.getPrototypeOf(value);

	while (prototype !== null && !visited.has(prototype)) {
		visited.add(prototype);
		if (isIntrinsicConstructorPrototype(prototype, expectedName)) {
			return true;
		}
		prototype = Object.getPrototypeOf(prototype);
	}
	return false;
}

/**
 * Verifies that `obj` genuinely is the type its tag claims, via an
 * internal-slot probe. Promise and Error have no side-effect-free standard
 * probe, so their visible tags remain conservative; masked instances are
 * identified separately through their native prototype chain.
 */
function hasBrand(obj: object, tag: string): boolean {
	try {
		switch (tag) {
			case "[object Date]":
				dateGetTime.call(obj);
				return true;
			case "[object RegExp]":
				regExpSourceGet.call(obj);
				return true;
			case "[object Map]":
				mapSizeGet.call(obj);
				return true;
			case "[object Set]":
				setSizeGet.call(obj);
				return true;
			case "[object WeakMap]":
				weakMapHas.call(obj, PROBE_KEY);
				return true;
			case "[object WeakSet]":
				weakSetHas.call(obj, PROBE_KEY);
				return true;
			case "[object DataView]":
				dataViewByteLengthGet.call(obj);
				return true;
			case "[object ArrayBuffer]":
				arrayBufferByteLengthGet.call(obj);
				return true;
			case "[object SharedArrayBuffer]":
				if (!sharedArrayBufferByteLengthGet) return false;
				sharedArrayBufferByteLengthGet.call(obj);
				return true;
			case "[object Boolean]":
				booleanValueOf.call(obj);
				return true;
			case "[object Number]":
				numberValueOf.call(obj);
				return true;
			case "[object String]":
				stringValueOf.call(obj);
				return true;
			case "[object BigInt]":
				bigIntValueOf.call(obj);
				return true;
			case "[object Promise]":
				return hasNativePrototype(obj, "Promise");
			case "[object Error]":
				return ERROR_INTRINSIC_NAMES.some((name) =>
					hasNativePrototype(obj, name),
				);
			default:
				return false;
		}
	} catch {
		return false;
	}
}

/**
 * Returns `true` when `obj` is a built-in JavaScript type that should be
 * treated atomically (compared/cloned as a unit, not walked structurally).
 * Cross-realm safe, and brand-verified: a plain object spoofing a built-in
 * tag via `Symbol.toStringTag` returns `false` and is walked structurally
 * like any other plain object instead of crashing type-specific code.
 *
 * @param obj - The object to classify
 * @param tag - The result of `Object.prototype.toString.call(obj)`, passed
 *              in so callers that already computed it don't pay twice
 */
export function isBuiltInObject(obj: object, tag: string): boolean {
	// ArrayBuffer views (DataView + all TypedArrays, present and future)
	// carry an unforgeable internal slot, the strongest brand check.
	if (ArrayBuffer.isView(obj)) return true;
	// A built-in-looking TypedArray tag WITHOUT the view brand is spoofed.
	if (tag.endsWith("Array]")) return false;
	return BUILT_IN_TAGS.has(tag) && hasBrand(obj, tag);
}
