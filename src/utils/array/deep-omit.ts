import { isBuiltInObject, REFERENCE_COMPARED_TAGS } from "./is-built-in";

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
 * `ignoreKeyPredicate`. Built-in atomic types that `deepEqual` compares by
 * value (Date, RegExp, Map, Set, TypedArrays, DataView) are cloned by type
 * rather than walked, since their internal structure has no key filtering to
 * apply. Types that `deepEqual` compares by reference (Error, ArrayBuffer,
 * SharedArrayBuffer, Promise, WeakMap, WeakSet) are passed through by
 * reference, so `deepEqualExcept(x, x)` stays reflexive. Cycles are
 * preserved: a cycle `a → a` clones to `a' → a'`. Arrays retain sparse
 * holes and all non-ignored own properties, including symbol keys.
 *
 * **Shared references.** Without `ignoreKeyPredicate`, an object reached
 * via several paths dedupes to a single clone. With a predicate, each
 * path gets its own clone, because the predicate may decide differently per
 * path, so memoising the first path's result would be wrong. This is
 * inherently exponential for diamond-shaped sharing (a node reachable
 * via 2^n paths is cloned 2^n times); the walk aborts with a descriptive
 * error after {@link PATH_SENSITIVE_VISIT_BUDGET} node visits instead of
 * hanging the process.
 *
 * **Prototype-pollution safety.** `__proto__` and `constructor` keys
 * encountered as *own* properties of the input (typical of `JSON.parse`
 * output) are copied as inert data properties via `Object.defineProperty`
 * so the clone graph cannot bleed into `Object.prototype`.
 *
 * **Class instances.** When the input is a class instance, the clone is
 * built via `Object.create(proto)` so the prototype is preserved, but the
 * constructor is NOT re-invoked, so class invariants enforced by the
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
	// With a path-sensitive predicate, a clone computed under one path must
	// NOT be reused for the same object reached via another path (the
	// predicate may decide differently there). The cache then only tracks
	// in-progress ancestors (pure cycle detection) instead of memoising
	// completed subtrees. Without a predicate, results are path-independent
	// and shared references keep deduplicating to one clone. The budget
	// bounds the per-path expansion (exponential on diamond sharing).
	const budget = options.ignoreKeyPredicate ? { visits: 0 } : undefined;
	return omitInternal(value, options, ignoreKeys, [], visited, budget) as T;
}

/**
 * Maximum object-node visits for a single path-sensitive `deepOmit` walk.
 * Per-path cloning expands exponentially on diamond-shaped sharing; past
 * this bound the walk throws instead of hanging the process. One million
 * visits covers any realistically tree-shaped input.
 */
const PATH_SENSITIVE_VISIT_BUDGET = 1_000_000;

function omitInternal(
	value: unknown,
	options: DeepOmitOptions,
	ignoreKeys: ReadonlySet<Key> | undefined,
	path: PathSegment[],
	visited: WeakMap<object, unknown>,
	budget: { visits: number } | undefined,
): unknown {
	if (value === null) return value;
	if (typeof value !== "object") return value;

	const obj = value as object;

	// Cycles (and, in the path-independent case, shared references): return
	// the cached clone. Use `has` (not `cached !== undefined`) so a
	// legitimately-undefined cached clone would not be misclassified as
	// "never seen".
	if (visited.has(obj)) {
		return visited.get(obj);
	}

	if (budget && ++budget.visits > PATH_SENSITIVE_VISIT_BUDGET) {
		throw new Error(
			`deepOmit: exceeded ${PATH_SENSITIVE_VISIT_BUDGET} node visits. ` +
				`With ignoreKeyPredicate, objects reached via shared references ` +
				`are cloned once per path (the predicate may decide differently ` +
				`per path), which expands exponentially on diamond-shaped ` +
				`sharing. Restructure the input to a tree, or use ignoreKeys ` +
				`for path-independent filtering.`,
		);
	}

	// Arrays: recursively process every own property so sparse holes, custom
	// properties, symbols, and descriptors remain observable to deepEqual.
	// `Array.isArray` is brand-based and immune to `Symbol.toStringTag` spoofing.
	if (Array.isArray(obj)) {
		const arr = obj as unknown[];
		const clone: unknown[] = new Array(arr.length);
		visited.set(obj, clone);
		for (const key of Reflect.ownKeys(arr)) {
			if (key === "length") continue;
			if (shouldIgnoreKey(key, path, ignoreKeys, options)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(arr, key);
			if (descriptor === undefined) continue;

			path.push(arrayPathSegment(key));
			if ("value" in descriptor) {
				descriptor.value = omitInternal(
					descriptor.value,
					options,
					ignoreKeys,
					path,
					visited,
					budget,
				);
			}
			Object.defineProperty(clone, key, descriptor);
			path.pop();
		}
		if (budget) visited.delete(obj);
		return clone;
	}

	const tag = Object.prototype.toString.call(obj);

	// Built-in atomic types: clone by type rather than walk. The detection
	// is brand-verified: a plain object spoofing a built-in tag falls
	// through to the plain-object walk below.
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
				budget,
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
				budget,
			),
		);
		path.pop();
	}

	if (budget) visited.delete(obj);
	return clone;
}

function arrayPathSegment(key: string | symbol): PathSegment {
	if (typeof key === "symbol") return key;
	const index = Number(key);
	return Number.isInteger(index) &&
		index >= 0 &&
		index < 4_294_967_295 &&
		String(index) === key
		? index
		: key;
}

/**
 * Assigns `value` as an OWN data property on `target` without going through
 * any inherited setter; critically, it never invokes the `__proto__` setter
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
 * for anything not explicitly enumerated (e.g. DataView, TypedArrays,
 * Boolean/Number/String wrappers, all of which `deepEqual` compares by
 * value). Types that `deepEqual` compares BY REFERENCE (the shared
 * {@link REFERENCE_COMPARED_TAGS} set) are passed through by reference
 * instead; cloning them would make `deepEqualExcept(x, x)` false.
 * Promise/WeakMap/WeakSet additionally cannot be cloned at all
 * (`structuredClone` rejects them).
 */
function cloneBuiltIn(obj: object, tag: string): unknown {
	if (REFERENCE_COMPARED_TAGS.has(tag)) return obj;
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
