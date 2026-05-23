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
 * Creates a deep copy of `value` with certain keys removed according to the
 * provided rules.
 *
 * Walks the object tree and skips keys that match `ignoreKeys` /
 * `ignoreKeyPredicate`. Built-in atomic types (Date, RegExp, Map, Set,
 * TypedArrays, ArrayBuffer, DataView) are cloned by type rather than walked
 * — their internal structure has no key filtering to apply. Cycles are
 * preserved: a cycle `a → a` clones to `a' → a'`.
 *
 * **Prototype-pollution safety.** `__proto__` and `constructor` keys
 * encountered as *own* properties of the input (typical of `JSON.parse`
 * output) are copied as inert data properties via `Object.defineProperty`
 * so the clone graph cannot bleed into `Object.prototype`.
 *
 * **Class instances.** When the input is a class instance, the clone is
 * built via `Object.create(proto)` so the prototype is preserved, but the
 * constructor is NOT re-invoked — so class invariants enforced by the
 * constructor are not re-checked. `deepOmit` is therefore best used for
 * comparison/serialisation (`voEqualsExcept`, `deepEqualExcept`), not as
 * a general-purpose clone for behaviour-carrying objects.
 *
 * @param value - The value to create a deep copy from
 * @param options - Options specifying which keys to ignore
 * @returns A deep copy of `value` with specified keys removed
 */
export function deepOmit<T>(value: T, options: DeepOmitOptions): T {
	const visited = new WeakMap<object, unknown>();
	// Materialise ignoreKeys as a Set once so the inner loop probes O(1).
	const ignoreKeys = options.ignoreKeys
		? new Set<Key>(options.ignoreKeys)
		: undefined;
	return omitInternal(value, options, ignoreKeys, [], visited) as T;
}

function omitInternal(
	value: unknown,
	options: DeepOmitOptions,
	ignoreKeys: ReadonlySet<Key> | undefined,
	path: PathSegment[],
	visited: WeakMap<object, unknown>,
): unknown {
	if (value === null) return value;
	if (typeof value !== "object") return value;

	const obj = value as object;

	// Cycles: return cached clone if already visited. Use `has` (not
	// `cached !== undefined`) so a legitimately-undefined cached clone
	// would not be misclassified as "never seen".
	if (visited.has(obj)) {
		return visited.get(obj);
	}

	const tag = Object.prototype.toString.call(obj);

	// Arrays: recursively process elements
	if (tag === "[object Array]") {
		const arr = obj as unknown[];
		const clone: unknown[] = new Array(arr.length);
		visited.set(obj, clone);
		for (let i = 0; i < arr.length; i++) {
			path.push(i);
			clone[i] = omitInternal(arr[i], options, ignoreKeys, path, visited);
			path.pop();
		}
		return clone;
	}

	// Built-in atomic types: clone by type rather than walk.
	if (isBuiltInObject(obj, tag)) {
		const builtInClone = cloneBuiltIn(obj, tag);
		visited.set(obj, builtInClone);
		return builtInClone;
	}

	// Plain / Custom Objects: filter keys, recursively process values.
	const clone = Object.create(Object.getPrototypeOf(obj));
	visited.set(obj, clone);

	const stringKeys = Object.keys(obj);
	const symbolKeys = Object.getOwnPropertySymbols(obj);

	for (const key of stringKeys) {
		if (shouldIgnoreKey(key, path, ignoreKeys, options)) continue;
		path.push(key);
		assignOwn(
			clone,
			key,
			omitInternal(
				(obj as Record<PropertyKey, unknown>)[key],
				options,
				ignoreKeys,
				path,
				visited,
			),
		);
		path.pop();
	}
	for (const key of symbolKeys) {
		if (shouldIgnoreKey(key, path, ignoreKeys, options)) continue;
		path.push(key);
		assignOwn(
			clone,
			key,
			omitInternal(
				(obj as Record<PropertyKey, unknown>)[key],
				options,
				ignoreKeys,
				path,
				visited,
			),
		);
		path.pop();
	}

	return clone;
}

/**
 * Assigns `value` as an OWN data property on `target` without going through
 * any inherited setter — critically, never invokes the `__proto__` setter
 * even when `key === "__proto__"`. Required to defeat prototype-pollution
 * payloads that ship `__proto__` as a parsed-JSON own key.
 */
function assignOwn(target: object, key: PropertyKey, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		writable: true,
		enumerable: true,
		configurable: true,
	});
}

/**
 * Clones a built-in atomic type by case. Falls back to `structuredClone`
 * for anything not explicitly enumerated (e.g. ArrayBuffer, DataView,
 * Boolean/Number/String wrappers).
 */
function cloneBuiltIn(obj: object, tag: string): unknown {
	switch (tag) {
		case "[object Date]":
			return new Date((obj as Date).getTime());
		case "[object RegExp]": {
			const re = obj as RegExp;
			const copy = new RegExp(re.source, re.flags);
			copy.lastIndex = re.lastIndex;
			return copy;
		}
		case "[object Map]": {
			const m = obj as Map<unknown, unknown>;
			return new Map(m);
		}
		case "[object Set]": {
			const s = obj as Set<unknown>;
			return new Set(s);
		}
		default:
			return structuredClone(obj);
	}
}

function shouldIgnoreKey(
	key: Key,
	path: readonly PathSegment[],
	ignoreKeys: ReadonlySet<Key> | undefined,
	options: DeepOmitOptions,
): boolean {
	if (ignoreKeys?.has(key)) return true;
	if (options.ignoreKeyPredicate?.(key, path)) return true;
	return false;
}
