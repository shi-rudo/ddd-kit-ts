import { isBuiltInObject } from "./is-built-in";

const objProto = Object.prototype;
const objToString = objProto.toString;
const objHasOwn = objProto.hasOwnProperty;

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
 * previously cached b for that a is walked normally — the previous shape
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
		const arrA = objA as unknown as Record<number, unknown> & { length: number };
		const arrB = objB as unknown as Record<number, unknown> & { length: number };

		const len = arrA.length;
		if (len !== arrB.length) return false;

		for (let i = 0; i < len; i++) {
			if (arrA[i] !== arrB[i]) return false;
		}
		return true;
	}

	// 5. Tag-based type detection (robust across realms)
	const tagA = objToString.call(objA);
	const tagB = objToString.call(objB);
	if (tagA !== tagB) return false;

	switch (tagA) {
		case "[object Array]": {
			const arrA = objA as unknown[];
			const arrB = objB as unknown[];
			const len = arrA.length;
			if (len !== arrB.length) return false;

			for (let i = 0; i < len; i++) {
				if (!deepEqualInner(arrA[i], arrB[i], visited)) return false;
			}
			return true;
		}

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
			const timeA = (objA as Date).getTime();
			const timeB = (objB as Date).getTime();
			return timeA === timeB;
		}

		case "[object RegExp]": {
			const regA = objA as RegExp;
			const regB = objB as RegExp;
			return regA.source === regB.source && regA.flags === regB.flags;
		}

		case "[object Boolean]":
		case "[object Number]":
		case "[object String]": {
			// Wrapper objects (new Boolean/Number/String)
			return (objA as any).valueOf() === (objB as any).valueOf();
		}

		default: {
			// 6. Check if this is an unhandled built-in type (future-proof)
			// If both are built-ins but not handled above, they should be compared by reference
			// (since we don't know their internal structure)
			if (isBuiltInObject(objA, tagA) && isBuiltInObject(objB, tagB)) {
				// Unhandled built-in types: compare by reference as fallback
				// This ensures new built-ins don't fall through to plain object comparison
				return objA === objB;
			}

			// 7. Fallback: plain / custom objects → compare own enumerable keys + values
			const recA = objA as Record<string | symbol, unknown>;
			const recB = objB as Record<string | symbol, unknown>;

			const stringKeysA = Object.keys(objA as object);
			const stringKeysB = Object.keys(objB as object);
			if (stringKeysA.length !== stringKeysB.length) return false;

			const symbolKeysA = Object.getOwnPropertySymbols(objA as object);
			const symbolKeysB = Object.getOwnPropertySymbols(objB as object);
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
	}
}
