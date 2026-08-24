import { isBuiltInObject, isOpaqueExoticTag } from "./is-built-in";

const objProto = Object.prototype;
const objToString = objProto.toString;
const objHasOwn = objProto.hasOwnProperty;

/**
 * SameValueZero: `===` plus NaN-equals-NaN (and `+0 === -0`, unlike
 * `Object.is`). The numeric semantics `deepEqual` documents for primitives,
 * applied consistently inside TypedArrays, Dates and Number wrappers.
 */
function sameValueZero(a: unknown, b: unknown): boolean {
	return a === b || (Number.isNaN(a as number) && Number.isNaN(b as number));
}

/**
 * Performs a deep equality check between two values.
 *
 * This function compares values recursively, handling:
 * - Primitives (with special handling for NaN)
 * - Arrays (nested arrays supported)
 * - Objects (plain objects and class instances)
 * - TypedArrays (Uint8Array, Int32Array, etc.)
 * - DataView
 * - Maps and Sets
 * - Dates and RegExp
 * - Wrapper objects (Boolean, Number, String)
 * - Circular references (detected and handled)
 *
 * @param a - The first value to compare
 * @param b - The second value to compare
 * @returns `true` if the values are deeply equal, `false` otherwise
 *
 * @example
 * ```ts
 * deepEqual([1, 2, 3], [1, 2, 3]); // true
 * deepEqual({ a: 1, b: [2, 3] }, { a: 1, b: [2, 3] }); // true
 * deepEqual(NaN, NaN); // true
 * deepEqual([1, 2], [1, 2, 3]); // false
 * ```
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	return deepEqualInner(a, b, new WeakMap<object, WeakSet<object>>());
}

/**
 * Visited pair tracker for cycle detection. The cache is a pair-set:
 * for every left-hand object we keep the set of right-hand objects we
 * have already paired it with. Encountering an already-known pair returns
 * the cycle hypothesis (assume equal); a new (a, b') pair with b' ≠ any
 * previously cached b for that a is walked normally. The previous shape
 * (`WeakMap<object, object>`) could only remember one B per A, which
 * could short-circuit unrelated comparisons that happened to revisit the
 * same A with a different B.
 */
type VisitedPairs = WeakMap<object, WeakSet<object>>;

/**
 * Internal recursive function for deep equality comparison.
 *
 * @internal
 */
function deepEqualInner(
	a: unknown,
	b: unknown,
	visited: VisitedPairs,
): boolean {
	// 1. Fast path: reference equality
	if (a === b) return true;

	const typeA = typeof a;
	const typeB = typeof b;

	// 2. If one is not an object → primitive / function
	if (typeA !== "object" || a === null || typeB !== "object" || b === null) {
		// Special case: NaN should be equal
		if (typeA === "number" && typeB === "number") {
			return Number.isNaN(a as number) && Number.isNaN(b as number);
		}
		// Everything else is directly unequal with !== (including functions)
		return false;
	}

	// From here on: both are non-null objects

	const objA = a as object;
	const objB = b as object;

	// 3. Cycles: already seen this exact (a, b) pair?
	let cachedBs = visited.get(objA);
	if (cachedBs?.has(objB)) {
		// Cycle hypothesis: pretend equal so the walk can terminate. If the
		// structure is actually unequal elsewhere, a different recursive
		// branch will surface the mismatch.
		return true;
	}
	if (!cachedBs) {
		cachedBs = new WeakSet();
		visited.set(objA, cachedBs);
	}
	cachedBs.add(objB);

	// 4. Handle Typed Arrays / DataView first
	if (ArrayBuffer.isView(objA) || ArrayBuffer.isView(objB)) {
		if (!ArrayBuffer.isView(objA) || !ArrayBuffer.isView(objB)) return false;

		const tagA = objToString.call(objA);
		const tagB = objToString.call(objB);
		if (tagA !== tagB) return false;

		// DataView: compare byte by byte
		if (tagA === "[object DataView]") {
			const viewA = objA as DataView;
			const viewB = objB as DataView;
			if (viewA.byteLength !== viewB.byteLength) return false;

			const len = viewA.byteLength;
			for (let i = 0; i < len; i++) {
				if (viewA.getUint8(i) !== viewB.getUint8(i)) return false;
			}
			return true;
		}

		// Typed Arrays: element by element (length + numeric index access are
		// part of the TypedArray contract; the indexed read is sound).
		const arrA = objA as unknown as Record<number, unknown> & {
			length: number;
		};
		const arrB = objB as unknown as Record<number, unknown> & {
			length: number;
		};

		const len = arrA.length;
		if (len !== arrB.length) return false;

		for (let i = 0; i < len; i++) {
			if (!sameValueZero(arrA[i], arrB[i])) return false;
		}
		return true;
	}

	// 5. Arrays: `Array.isArray` is brand-based and immune to
	// `Symbol.toStringTag` spoofing (a spoofed tag would otherwise route a
	// real array away from element comparison, or a plain object into it).
	if (Array.isArray(objA) || Array.isArray(objB)) {
		if (!Array.isArray(objA) || !Array.isArray(objB)) return false;
		if (objA.length !== objB.length) return false;

		const keysA = Reflect.ownKeys(objA).filter((key) => key !== "length");
		const keysB = Reflect.ownKeys(objB).filter((key) => key !== "length");
		if (keysA.length !== keysB.length) return false;

		const arrA = objA as unknown as Record<PropertyKey, unknown>;
		const arrB = objB as unknown as Record<PropertyKey, unknown>;
		for (const key of keysA) {
			if (!objHasOwn.call(objB, key)) return false;
			// Read the element by access (invoking any getter) rather than
			// comparing accessor descriptors by function identity, so an array
			// index defined as a getter is compared by the value it yields,
			// matching how comparePlainObjects treats accessor properties.
			// Sparse holes stay observable through the key-set comparison above:
			// a hole leaves no own key, so two arrays that differ by a hole vs
			// an explicit undefined have different key sets.
			if (!deepEqualInner(arrA[key], arrB[key], visited)) {
				return false;
			}
		}
		return true;
	}

	// 6. Tag-based type detection (robust across realms), brand-verified:
	// a plain object spoofing a built-in tag is compared as a plain object
	// instead of crashing type-specific code below.
	const tagA = objToString.call(objA);
	const tagB = objToString.call(objB);
	if (tagA !== tagB) return false;

	const builtInA = isBuiltInObject(objA, tagA);
	const builtInB = isBuiltInObject(objB, tagB);
	// A genuine built-in never equals a spoofed lookalike.
	if (builtInA !== builtInB) return false;

	if (!builtInA) {
		// Opaque intrinsics (boxed Symbol, generator, WeakRef, ...):
		// identity is the only honest comparison; symmetric because
		// tagA === tagB was already enforced above.
		if (isOpaqueExoticTag(tagA)) return objA === objB;
		return comparePlainObjects(objA, objB, visited);
	}

	switch (tagA) {
		case "[object Map]": {
			const mapA = objA as Map<unknown, unknown>;
			const mapB = objB as Map<unknown, unknown>;

			if (mapA.size !== mapB.size) return false;

			for (const [key, valA] of mapA) {
				// Map keys according to JS semantics: reference / SameValueZero
				if (!mapB.has(key)) return false;
				const valB = mapB.get(key);
				if (!deepEqualInner(valA, valB, visited)) return false;
			}
			return true;
		}

		case "[object Set]": {
			const setA = objA as Set<unknown>;
			const setB = objB as Set<unknown>;

			if (setA.size !== setB.size) return false;

			// Set elements: same reference (JS semantics)
			for (const value of setA) {
				if (!setB.has(value)) return false;
			}
			return true;
		}

		case "[object Date]": {
			// SameValueZero so two invalid Dates (getTime() === NaN) compare
			// equal, matching the primitive NaN semantics.
			return sameValueZero((objA as Date).getTime(), (objB as Date).getTime());
		}

		case "[object RegExp]": {
			const regA = objA as RegExp;
			const regB = objB as RegExp;
			return regA.source === regB.source && regA.flags === regB.flags;
		}

		case "[object Boolean]":
		case "[object Number]":
		case "[object String]":
		case "[object BigInt]": {
			// Wrapper objects (Boolean/Number/String/BigInt); SameValueZero so
			// two NaN Number wrappers compare equal.
			return sameValueZero(
				(objA as { valueOf(): unknown }).valueOf(),
				(objB as { valueOf(): unknown }).valueOf(),
			);
		}

		default: {
			// Unhandled but brand-trusted built-ins: compared by reference.
			// Their internal structure is unknown, and this keeps new
			// built-ins from falling through to plain-object comparison.
			// This branch IS the REFERENCE_COMPARED_TAGS contract exported
			// from is-built-in.ts (and consumed by deepOmit's cloneBuiltIn):
			// adding a by-value case above means removing the tag there.
			return objA === objB;
		}
	}
}

/**
 * Plain / custom objects: compare own enumerable string keys + own symbol
 * keys and their values. Used both as the final fallback and for objects
 * whose built-in-looking tag failed brand verification.
 */
function comparePlainObjects(
	objA: object,
	objB: object,
	visited: VisitedPairs,
): boolean {
	const recA = objA as Record<string | symbol, unknown>;
	const recB = objB as Record<string | symbol, unknown>;

	// Own string keys including non-enumerable ones: symbols are already
	// counted through Object.getOwnPropertySymbols (which ignores
	// enumerability), so using Object.keys here would let two objects that
	// differ only by a non-enumerable string property compare equal.
	const stringKeysA = Object.getOwnPropertyNames(objA);
	const stringKeysB = Object.getOwnPropertyNames(objB);
	if (stringKeysA.length !== stringKeysB.length) return false;

	const symbolKeysA = Object.getOwnPropertySymbols(objA);
	const symbolKeysB = Object.getOwnPropertySymbols(objB);
	if (symbolKeysA.length !== symbolKeysB.length) return false;

	// Build the B-side symbol set once; the previous impl rebuilt the
	// array and ran .includes per key, which was quadratic.
	const symbolKeysBSet = new Set<symbol>(symbolKeysB);

	for (const key of stringKeysA) {
		if (!objHasOwn.call(objB, key)) return false;
	}
	for (const key of symbolKeysA) {
		if (!symbolKeysBSet.has(key)) return false;
	}

	for (const key of stringKeysA) {
		if (!deepEqualInner(recA[key], recB[key], visited)) {
			return false;
		}
	}
	for (const key of symbolKeysA) {
		if (!deepEqualInner(recA[key], recB[key], visited)) {
			return false;
		}
	}

	return true;
}
