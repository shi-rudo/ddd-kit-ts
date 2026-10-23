/**
 * The built-ins that the structural helpers treat as a unit: they compare,
 * copy, or freeze such a value by type, not by walking its own keys. The
 * detection reads `Object.prototype.toString`, which gives the same answer
 * in every realm. A plain object can claim a tag through
 * `Symbol.toStringTag`; the kit trusts its caller there (see "The kit
 * catches accidents, not misuse" in the design decisions).
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

/** The tag that {@link builtInTag} reports. Every typed array reports `"[object TypedArray]"`. */
export type BuiltInTag =
	| "[object Date]"
	| "[object RegExp]"
	| "[object Map]"
	| "[object Set]"
	| "[object WeakMap]"
	| "[object WeakSet]"
	| "[object Promise]"
	| "[object Error]"
	| "[object Boolean]"
	| "[object Number]"
	| "[object String]"
	| "[object BigInt]"
	| "[object ArrayBuffer]"
	| "[object SharedArrayBuffer]"
	| "[object DataView]"
	| "[object TypedArray]";

const objectToString = Object.prototype.toString;

/** The built-in tag of `value`, or `undefined` for any other object. */
export function builtInTag(value: object): BuiltInTag | undefined {
	if (ArrayBuffer.isView(value)) {
		return objectToString.call(value) === "[object DataView]"
			? "[object DataView]"
			: "[object TypedArray]";
	}
	const tag = objectToString.call(value);
	return BUILT_IN_TAGS.has(tag) ? (tag as BuiltInTag) : undefined;
}

/** The type name in a tag: `"Map"` for `"[object Map]"`. */
export function builtInTypeName(tag: BuiltInTag): string {
	return tag.slice(8, -1);
}

/**
 * Whether `obj`, whose `Object.prototype.toString` tag is `tag`, is a
 * built-in that the structural helpers treat as a unit.
 */
export function isBuiltInObject(obj: object, tag: string): boolean {
	return ArrayBuffer.isView(obj) || BUILT_IN_TAGS.has(tag);
}

/**
 * Tags that `deepEqual` compares BY REFERENCE (its unhandled-built-in
 * fallback) and that `deepOmit` must therefore ALIAS rather than clone:
 * a clone would break `deepEqualExcept(x, x)` reflexivity. If `deepEqual`
 * learns a by-value comparison for one of these, remove it here and add a
 * clone case in `deepOmit` in the same change.
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
 * structural walk can observe (boxed Symbols, generator objects, WeakRefs,
 * FinalizationRegistry handles). `deepEqual` compares them by identity and
 * `deepOmit` passes them through by reference; treating them as (empty)
 * plain objects would make all such exotics equal to each other.
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

/** Whether `value` is a `WeakMap` of any realm. */
export function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		objectToString.call(value) === "[object WeakMap]"
	);
}
