import { deepEqual } from "./deep-equal";
import { type DeepOmitOptions, deepOmit } from "./deep-omit";

export type DeepEqualExceptOptions = DeepOmitOptions;

/**
 * Performs a deep equality comparison between two values after omitting specified keys.
 * 
 * This function first removes the specified keys from both values using `deepOmit`,
 * then performs a deep equality check using `deepEqual`.
 * 
 * @param a - The first value to compare
 * @param b - The second value to compare
 * @param options - Options specifying which keys to omit before comparison
 * @returns `true` if the values are deeply equal after omitting specified keys, `false` otherwise
 * 
 * @example
 * ```ts
 * const obj1 = { id: 1, name: "Alice", updatedAt: "2024-01-01" };
 * const obj2 = { id: 2, name: "Alice", updatedAt: "2024-01-02" };
 * 
 * deepEqualExcept(obj1, obj2, { ignoreKeys: ["id", "updatedAt"] }); // true
 * ```
 */
export function deepEqualExcept(
	a: unknown,
	b: unknown,
	options: DeepEqualExceptOptions,
): boolean {
	const prunedA = deepOmit(a, options);
	const prunedB = deepOmit(b, options);
	return deepEqual(prunedA, prunedB);
}
