import {
	builtInTagWithoutInvokingAccessors,
	hasIntrinsicPrototypeChain,
	isIntrinsicConstructorPrototype,
} from "./is-built-in";

/**
 * Returns a copy of `state` that shares no object with the original.
 * Throws a `TypeError` that names the path when the graph carries a value
 * a structured clone would lose or silently degrade. A class instance, a
 * subclass of a built-in included, loses the methods on its prototype. A
 * symbol-keyed, non-enumerable, or accessor property and an expando on a
 * built-in are dropped. A function or a symbol value throws a raw
 * `DataCloneError`. An Error, a Promise, a WeakMap, or a WeakSet cannot be
 * detached at all. A SharedArrayBuffer and a view over one keep sharing
 * their memory. A Proxy is invisible to the walk and fails inside the
 * clone; that failure is rethrown as a `TypeError` with the cause.
 *
 * Plain objects (from any realm), arrays, Dates, Maps, Sets, bigints, and
 * typed arrays pass. A RegExp passes: pattern and flags survive the clone,
 * and `lastIndex` restores as 0. The scan state of a global or sticky
 * pattern is not domain data. A non-enumerable property on a built-in
 * passes: it is the built-in's own machinery (`lastIndex`), not data. A
 * non-enumerable symbol key passes anywhere: it is metadata by convention.
 *
 * The concrete entity uses it for a detached read DTO of a plain-data
 * state. The snapshot model uses it for the captured DTO and the restored
 * state. A state that carries a class-based child is mapped to plain data
 * first, in the entity or in the model.
 */
export function detachState<T>(state: T): T {
	assertDetachable(state, "", new WeakSet());
	try {
		return structuredClone(state);
	} catch (cause) {
		throw new TypeError(
			"detachState: state holds a Proxy or a host object that cannot be cloned; map it to plain data",
			{ cause },
		);
	}
}

const INDEX_KEY = /^(0|[1-9]\d*)$/;

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
		if (!hasIntrinsicPrototypeChain(object, "Array")) {
			throwClassInstance(object, path);
		}
		assertOwnPropertiesDetachable(object, path, seen, "array");
		return;
	}

	const tag = builtInTagWithoutInvokingAccessors(object);
	if (tag !== undefined) {
		if (!hasIntrinsicPrototypeChain(object)) {
			throwClassInstance(object, path);
		}
		if (tag === "[object Map]") {
			let index = 0;
			for (const [key, entry] of object as Map<unknown, unknown>) {
				assertDetachable(key, `${path}<map key #${index}>`, seen);
				assertDetachable(entry, `${path}<map value #${index}>`, seen);
				index++;
			}
		} else if (tag === "[object Set]") {
			let index = 0;
			for (const member of object as Set<unknown>) {
				assertDetachable(member, `${path}<set member #${index}>`, seen);
				index++;
			}
		} else if (
			tag === "[object Promise]" ||
			tag === "[object WeakMap]" ||
			tag === "[object WeakSet]"
		) {
			throw new TypeError(
				`detachState: state${path} is a ${tag.slice(8, -1)} and cannot be detached`,
			);
		} else if (tag === "[object Error]") {
			throw new TypeError(
				`detachState: state${path} is an Error; map it to plain data`,
			);
		} else if (sharesMemory(object, tag)) {
			throw new TypeError(
				`detachState: state${path} is backed by a SharedArrayBuffer and the copy would share its memory; map it to plain data`,
			);
		}
		assertOwnPropertiesDetachable(object, path, seen, "built-in");
		return;
	}

	const prototype = Object.getPrototypeOf(object);
	const isPlainRecord =
		prototype === null ||
		(isIntrinsicConstructorPrototype(prototype, "Object") &&
			Object.getPrototypeOf(prototype) === null);
	if (!isPlainRecord) {
		throwClassInstance(object, path);
	}
	assertOwnPropertiesDetachable(object, path, seen, "record");
}

/**
 * Audits the own properties the clone would copy or drop. The clone keeps
 * the enumerable own keys of a record and of an array, expandos included,
 * and drops every own key of another built-in. `length` on an array and
 * the non-enumerable keys of a built-in (`lastIndex`) are its own
 * machinery, not data. Index keys of a typed array or a boxed String are
 * its content and pass as such.
 */
function assertOwnPropertiesDetachable(
	object: object,
	path: string,
	seen: WeakSet<object>,
	kind: "array" | "built-in" | "record",
): void {
	for (const key of Reflect.ownKeys(object)) {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		if (descriptor === undefined) continue;
		if (typeof key === "symbol") {
			if (!descriptor.enumerable) continue;
			throw new TypeError(
				`detachState: state${path} has a symbol-keyed property; map it to plain data`,
			);
		}
		if (kind === "array" && key === "length") continue;
		const isIndex = INDEX_KEY.test(key);
		if (!descriptor.enumerable) {
			if (kind === "built-in") continue;
			throw new TypeError(
				`detachState: state${path}.${key} is not enumerable and the clone would drop it; map it to plain data`,
			);
		}
		if (kind === "built-in" && isIndex) continue;
		const memberPath = isIndex ? `${path}[${key}]` : `${path}.${key}`;
		if (!("value" in descriptor)) {
			throw new TypeError(
				`detachState: state${memberPath} is an accessor property; map it to plain data`,
			);
		}
		if (kind === "built-in") {
			throw new TypeError(
				`detachState: state${memberPath} is an expando on a ${object.constructor?.name ?? "built-in"} and the clone would drop it; map it to plain data`,
			);
		}
		assertDetachable(descriptor.value, memberPath, seen);
	}
}

function sharesMemory(object: object, tag: string): boolean {
	if (tag === "[object SharedArrayBuffer]") return true;
	return (
		ArrayBuffer.isView(object) &&
		Object.prototype.toString.call(object.buffer) ===
			"[object SharedArrayBuffer]"
	);
}

function throwClassInstance(object: object, path: string): never {
	const name: string =
		Object.getPrototypeOf(object)?.constructor?.name || "anonymous class";
	throw new TypeError(
		`detachState: state${path} is a class instance (${name}); map it to plain data`,
	);
}
