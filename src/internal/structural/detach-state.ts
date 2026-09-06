import { isBuiltInObject } from "./is-built-in";

/**
 * Returns a copy of `state` that shares no object with the original.
 * Throws a `TypeError` naming the path when the graph carries a value a
 * structured clone would lose or silently degrade: a class instance loses
 * the methods on its prototype, a symbol-keyed property is dropped, a
 * function or a symbol value throws a raw `DataCloneError`, and an Error,
 * a Promise, a WeakMap, or a WeakSet cannot be detached at all.
 *
 * Plain objects, arrays, Dates, Maps, Sets, bigints, and typed arrays pass.
 * A RegExp passes: pattern and flags survive the clone, and `lastIndex`
 * restores as 0. The scan state of a global or sticky pattern is not
 * domain data.
 *
 * The concrete entity uses it for a detached read DTO of a plain-data
 * state; the snapshot model uses it for the captured DTO. A state that
 * carries a class-based child is mapped to plain data first, in the
 * entity or in the model.
 */
export function detachState<T>(state: T): T {
	assertDetachable(state, "", new WeakSet());
	return structuredClone(state);
}

function assertDetachable(
	value: unknown,
	path: string,
	seen: WeakSet<object>,
): void {
	if (typeof value === "function") {
		throw new TypeError(
			`detachState: state${path} is a function; map it to plain data`,
		);
	}
	// Guided rejection instead of the raw DataCloneError DOMException that
	// structuredClone throws for symbols, which no recovery channel catches.
	if (typeof value === "symbol") {
		throw new TypeError(
			`detachState: state${path} is a symbol; map it to plain data`,
		);
	}
	if (value === null || typeof value !== "object") return;
	const object = value as object;
	if (seen.has(object)) return;
	seen.add(object);

	if (Array.isArray(object)) {
		for (let index = 0; index < object.length; index++) {
			assertDetachable(object[index], `${path}[${index}]`, seen);
		}
		return;
	}

	const tag = Object.prototype.toString.call(object);
	if (isBuiltInObject(object, tag)) {
		if (tag === "[object Map]") {
			let index = 0;
			for (const [key, entry] of object as Map<unknown, unknown>) {
				assertDetachable(key, `${path}<map key #${index}>`, seen);
				assertDetachable(entry, `${path}<map value #${index}>`, seen);
				index++;
			}
			return;
		}
		if (tag === "[object Set]") {
			let index = 0;
			for (const member of object as Set<unknown>) {
				assertDetachable(member, `${path}<set member #${index}>`, seen);
				index++;
			}
			return;
		}
		if (
			tag === "[object Promise]" ||
			tag === "[object WeakMap]" ||
			tag === "[object WeakSet]"
		) {
			throw new TypeError(
				`detachState: state${path} is a ${tag.slice(8, -1)} and cannot be detached`,
			);
		}
		if (tag === "[object Error]") {
			throw new TypeError(
				`detachState: state${path} is an Error; map it to plain data`,
			);
		}
		return;
	}

	const prototype = Object.getPrototypeOf(object);
	if (prototype === Object.prototype || prototype === null) {
		for (const key of Reflect.ownKeys(object)) {
			const descriptor = Object.getOwnPropertyDescriptor(object, key);
			if (!descriptor?.enumerable) continue;
			if (typeof key === "symbol") {
				throw new TypeError(
					`detachState: state${path} has a symbol-keyed property; map it to plain data`,
				);
			}
			assertDetachable(
				(object as Record<PropertyKey, unknown>)[key],
				`${path}.${key}`,
				seen,
			);
		}
		return;
	}

	const name: string = prototype.constructor?.name || "anonymous class";
	throw new TypeError(
		`detachState: state${path} is a class instance (${name}); map it to plain data`,
	);
}
