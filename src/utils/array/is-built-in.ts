/**
 * Checks if an object is a built-in JavaScript type that should be treated atomically.
 * This function automatically detects built-ins without requiring manual maintenance.
 *
 * Detection strategy:
 * 1. TypedArrays: Check if tag ends with "Array]" (covers all current and future TypedArrays)
 * 2. ArrayBuffer views: Use ArrayBuffer.isView() (covers DataView and all TypedArrays)
 * 3. Built-in constructors: Check if constructor exists in global scope and matches known patterns
 * 4. Tag-based: Fallback to tag matching for known built-ins
 *
 * @param obj - The object to check
 * @param tag - The result of `Object.prototype.toString.call(obj)`
 * @returns `true` if the object is a built-in type, `false` otherwise
 */
export function isBuiltInObject(obj: object, tag: string): boolean {
	// 1. TypedArrays: all end with "Array]" - future-proof for new TypedArrays
	if (tag.endsWith("Array]")) {
		return true;
	}

	// 2. ArrayBuffer views: covers DataView and all TypedArrays (future-proof)
	if (ArrayBuffer.isView(obj)) {
		return true;
	}

	// 3. ArrayBuffer and SharedArrayBuffer
	if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") {
		return true;
	}

	// 4. Check if constructor exists in global scope (future-proof for new globals)
	const objConstructor = (obj as { constructor?: unknown }).constructor;
	if (objConstructor && typeof objConstructor === "function") {
		const constructorName = objConstructor.name;
		// Check if it's a known global constructor
		// This covers: Date, RegExp, Map, Set, WeakMap, WeakSet, Promise, Error, etc.
		if (
			constructorName &&
			typeof globalThis !== "undefined" &&
			constructorName in globalThis &&
			(globalThis as Record<string, unknown>)[constructorName] === objConstructor
		) {
			// Additional check: ensure it's not a user-defined class with same name
			// Built-ins typically have non-enumerable properties and specific prototypes
			const proto = Object.getPrototypeOf(obj);
			if (proto !== Object.prototype && proto !== null) {
				return true;
			}
		}
	}

	// 5. Tag-based fallback for known built-ins (covers edge cases)
	const knownBuiltInTags = new Set([
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
	]);

	return knownBuiltInTags.has(tag);
}

