/**
 * Set of `Object.prototype.toString.call(x)` tags that the library treats
 * as built-in atomic types. Members of this set are compared/cloned by
 * reference (or with type-specific logic) rather than walked structurally.
 *
 * The detection is purely tag-based — `Object.prototype.toString` reads
 * `Symbol.toStringTag`, which gives the same answer across realms (an
 * iframe's `Date` has the same tag as the main window's `Date`). The
 * previous strategy also checked `globalThis[name] === constructor` and a
 * `proto !== Object.prototype` heuristic; both broke for cross-realm
 * objects and the latter additionally misclassified ordinary user classes
 * as built-ins. Tag-only is the simplest robust choice.
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
	"[object ArrayBuffer]",
	"[object SharedArrayBuffer]",
	"[object DataView]",
]);

/**
 * Returns `true` when `obj` is a built-in JavaScript type that should be
 * treated atomically (compared/cloned as a unit, not walked structurally).
 * Cross-realm safe.
 *
 * @param obj - The object to classify
 * @param tag - The result of `Object.prototype.toString.call(obj)` — passed
 *              in so callers that already computed it don't pay twice
 */
export function isBuiltInObject(obj: object, tag: string): boolean {
	// All TypedArrays produce tags ending in "Array]" — future-proof match.
	if (tag.endsWith("Array]")) return true;
	// ArrayBuffer view covers DataView + all TypedArrays as a belt-and-braces.
	if (ArrayBuffer.isView(obj)) return true;
	return BUILT_IN_TAGS.has(tag);
}
