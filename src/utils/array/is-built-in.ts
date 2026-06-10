/**
 * Set of `Object.prototype.toString.call(x)` tags that the library treats
 * as built-in atomic types. Members of this set are compared/cloned by
 * reference (or with type-specific logic) rather than walked structurally.
 *
 * Detection is tag-based — `Object.prototype.toString` gives the same
 * answer across realms (an iframe's `Date` has the same tag as the main
 * window's `Date`) — and then brand-verified via internal-slot probes,
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
	"[object ArrayBuffer]",
	"[object SharedArrayBuffer]",
	"[object DataView]",
]);

// Intrinsic probes for brand verification. Each one reads an internal slot
// and throws a TypeError when `this` is not a genuine instance — the only
// check a plain object cannot spoof via `Symbol.toStringTag`. Captured once
// so a tampered prototype cannot redirect the probe later.
const dateGetTime = Date.prototype.getTime;
const mapSizeGet = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const setSizeGet = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;
const weakMapHas = WeakMap.prototype.has;
const weakSetHas = WeakSet.prototype.has;
const dataViewByteLengthGet = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"byteLength",
)!.get!;
const arrayBufferByteLengthGet = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
)!.get!;
const regExpSourceGet = Object.getOwnPropertyDescriptor(
	RegExp.prototype,
	"source",
)!.get!;
const booleanValueOf = Boolean.prototype.valueOf;
const numberValueOf = Number.prototype.valueOf;
const stringValueOf = String.prototype.valueOf;
const PROBE_KEY = {};

/**
 * Verifies that `obj` genuinely is the type its tag claims, via an
 * internal-slot probe. Tags without a cheap probe (Promise, Error,
 * SharedArrayBuffer) are trusted — their downstream handling is
 * reference-based and cannot crash on a spoofed object.
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
			case "[object Boolean]":
				booleanValueOf.call(obj);
				return true;
			case "[object Number]":
				numberValueOf.call(obj);
				return true;
			case "[object String]":
				stringValueOf.call(obj);
				return true;
			default:
				return true;
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
 * @param tag - The result of `Object.prototype.toString.call(obj)` — passed
 *              in so callers that already computed it don't pay twice
 */
export function isBuiltInObject(obj: object, tag: string): boolean {
	// ArrayBuffer views (DataView + all TypedArrays, present and future)
	// carry an unforgeable internal slot — the strongest brand check.
	if (ArrayBuffer.isView(obj)) return true;
	// A built-in-looking TypedArray tag WITHOUT the view brand is spoofed.
	if (tag.endsWith("Array]")) return false;
	return BUILT_IN_TAGS.has(tag) && hasBrand(obj, tag);
}
