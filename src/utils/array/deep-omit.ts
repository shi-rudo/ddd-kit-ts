import { isBuiltInObject } from "./is-built-in";

export type Key = string | symbol;
export type PathSegment = string | number | symbol;

export interface DeepOmitOptions {
	/**
	 * Keys to ignore everywhere in the object tree.
	 * Only applies to object properties, not Map/Set/TypedArray contents.
	 */
	readonly ignoreKeys?: readonly Key[];

	/**
	 * Fine-grained control: Key + path (without current key).
	 * Example path: ["user", "meta", 0, "data"]
	 */
	readonly ignoreKeyPredicate?: (
		key: Key,
		path: readonly PathSegment[],
	) => boolean;
}

/**
 * Creates a deep copy of `value` with certain keys removed according to the provided rules.
 *
 * This function recursively traverses the object tree and removes keys that match
 * the criteria specified in `options`. Built-in types (Date, Map, Set, TypedArrays, etc.)
 * are treated atomically and not modified.
 *
 * @param value - The value to create a deep copy from
 * @param options - Options specifying which keys to ignore
 * @returns A deep copy of `value` with specified keys removed
 *
 * @example
 * ```ts
 * const obj = { a: 1, b: { c: 2, d: 3 } };
 * const result = deepOmit(obj, { ignoreKeys: ['d'] });
 * // result: { a: 1, b: { c: 2 } }
 * ```
 */
export function deepOmit<T>(value: T, options: DeepOmitOptions): T {
	const visited = new WeakMap<object, unknown>();
	return omitInternal(value, options, [], visited) as T;
}

function omitInternal(
	value: unknown,
	options: DeepOmitOptions,
	path: PathSegment[],
	visited: WeakMap<object, unknown>,
): unknown {
	if (value === null) return value;
	const type = typeof value;

	// Primitives and functions are passed through unchanged
	if (type !== "object") return value;

	const obj = value as object;

	// Cycles: return cached value if already visited
	const cached = visited.get(obj);
	if (cached !== undefined) {
		return cached;
	}

	const tag = Object.prototype.toString.call(obj);

	// Arrays: recursively process elements
	if (tag === "[object Array]") {
		const arr = obj as unknown[];
		const clone: unknown[] = new Array(arr.length);
		visited.set(obj, clone);

		for (let i = 0; i < arr.length; i++) {
			path.push(i);
			clone[i] = omitInternal(arr[i], options, path, visited);
			path.pop();
		}
		return clone;
	}

	// Built-ins: treat atomically, no key filtering inside
	// Future-proof detection: check if object is a built-in type
	if (isBuiltInObject(obj, tag)) {
		return value;
	}

	// Plain / Custom Objects: filter keys, recursively process values
	const clone = Object.create(Object.getPrototypeOf(obj));
	visited.set(obj, clone);

	const stringKeys = Object.keys(obj);
	const symbolKeys = Object.getOwnPropertySymbols(obj);
	const keys: Key[] = [...stringKeys, ...symbolKeys];

	for (const key of keys) {
		if (shouldIgnoreKey(key, path, options)) continue;

		path.push(key);
		(clone as Record<PropertyKey, unknown>)[key] = omitInternal(
			(obj as Record<PropertyKey, unknown>)[key],
			options,
			path,
			visited,
		);
		path.pop();
	}

	return clone;
}

function shouldIgnoreKey(
	key: Key,
	path: readonly PathSegment[],
	options: DeepOmitOptions,
): boolean {
	if (options.ignoreKeys?.includes(key)) {
		return true;
	}
	if (options.ignoreKeyPredicate?.(key, path)) {
		return true;
	}
	return false;
}
