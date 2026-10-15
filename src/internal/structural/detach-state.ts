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
 * their memory. A Proxy fails in the walk or in the clone; a failure in
 * the clone is rethrown as a `TypeError` with the cause.
 *
 * The walk reads the graph through property descriptors and walks a Map
 * or a Set with the built-in iteration, so no accessor and no own iterator
 * of the state runs. A Proxy runs its traps during the walk. A trap can
 * change the graph, and an accessor that a trap adds runs during the
 * clone. A second walk checks the clone, so a value that a trap swapped in
 * and the content of a built-in whose prototype was replaced are rejected
 * too. A trap that changes the graph after the first walk can still hide a
 * value that the copy drops: the walks catch accidents, not a hostile
 * Proxy. The second walk also follows the steps of the first walk: the kind
 * of each object and the key of each data property, in walk order. A copy
 * that differs throws, because a built-in whose prototype was replaced is
 * a built-in again in the copy and loses its own properties. `subject`
 * names the state in the messages.
 *
 * Plain objects (from any realm), arrays, Dates, Maps, Sets, bigints, and
 * typed arrays pass. A RegExp passes: pattern and flags survive the clone,
 * and `lastIndex` restores as 0. The scan state of a global or sticky
 * pattern is not domain data. On a built-in, a non-enumerable function,
 * the `lastIndex` of a RegExp, and the `length` of a boxed String pass:
 * they are machinery, not data. Every other non-enumerable property
 * throws. A non-enumerable symbol key passes anywhere: it is metadata by
 * convention.
 *
 * The concrete entity uses it for a detached read DTO of a plain-data
 * state. The snapshot model uses it for the captured DTO and the restored
 * state. A state that carries a class-based child is mapped to plain data
 * first, in the entity or in the model.
 */
export function detachState<T>(state: T, subject = "detachState: state"): T {
	return detach(state, subject, "clone");
}

/**
 * {@link detachState} that also rejects what `deepFreeze` cannot make
 * immutable: binary data (a typed array, a DataView, an ArrayBuffer, or a
 * SharedArrayBuffer) and a RegExp. The walk rejects such a value at its
 * tag, before it reads the indices of a typed array. Kit modules only.
 */
export function detachFreezableState<T>(state: T, subject: string): T {
	return detach(state, subject, "freeze");
}

/**
 * Throws the `TypeError` of {@link detachFreezableState} and copies
 * nothing. A caller that has a clone already checks it with this, so the
 * rule is the same. Kit modules only.
 */
export function assertFreezableState(state: unknown, subject: string): void {
	assertDetachable(state, "", newWalk(subject, "freeze"));
}

function detach<T>(state: T, subject: string, rule: Walk["rule"]): T {
	const original = newWalk(subject, rule);
	assertDetachable(state, "", original);
	let copy: T;
	try {
		copy = structuredClone(state);
	} catch (cause) {
		throw new TypeError(
			`${subject} holds a Proxy or a host object that cannot be cloned, or a view over a detached or shrunk buffer; the cause names the value; map it to plain data`,
			{ cause },
		);
	}
	// The first walk trusts the prototype of an object, and a Proxy trap can
	// change the graph after it. The copy has genuine prototypes and no
	// Proxy, so this walk checks exactly what the caller gets. A built-in
	// whose prototype was replaced passes the first walk as a record, and
	// the copy drops its own properties. A count of the properties can
	// balance out with the content of the built-in, so this walk compares
	// each of its steps with the step of the first walk.
	const copied = newWalk(subject, rule, original.steps);
	assertDetachable(copy, "", copied);
	if (copied.steps.length !== original.steps.length) {
		throwChangedInCopy(subject, "");
	}
	return copy;
}

const INDEX_KEY = /^(0|[1-9]\d*)$/;
const BINARY_DATA_TAGS: ReadonlySet<string> = new Set([
	"[object TypedArray]",
	"[object DataView]",
	"[object ArrayBuffer]",
	"[object SharedArrayBuffer]",
]);
const REGEXP_TAG = "[object RegExp]";
const mapEntries = Map.prototype.entries;
const setValues = Set.prototype.values;

/**
 * A step of a walk: the kind of an object that the walk enters, or the key
 * of a data property of a record or an array that it checks. A kind is a
 * symbol, so no key can be equal to it.
 */
type Step = string | symbol;

const RECORD_STEP = Symbol("record");
const ARRAY_STEP = Symbol("array");
const builtInSteps = new Map<string, symbol>();

function builtInStep(tag: string): symbol {
	let kind = builtInSteps.get(tag);
	if (kind === undefined) {
		kind = Symbol(tag);
		builtInSteps.set(tag, kind);
	}
	return kind;
}

/**
 * The objects that the walk has seen, the subject that its messages name,
 * and its rule. `"clone"` accepts what a structured clone keeps. `"freeze"`
 * also rejects what `deepFreeze` cannot make immutable.
 */
interface Walk {
	readonly seen: WeakSet<object>;
	readonly subject: string;
	readonly rule: "clone" | "freeze";
	/** The steps of this walk, in walk order. */
	readonly steps: Step[];
	/**
	 * The steps of the walk over the original. A walk over the copy
	 * compares each of its steps with the step at the same position.
	 */
	readonly original: readonly Step[] | undefined;
}

function newWalk(
	subject: string,
	rule: Walk["rule"],
	original?: readonly Step[],
): Walk {
	return { seen: new WeakSet(), subject, rule, steps: [], original };
}

/**
 * Structured clone keeps the order of the keys, of Map entries, and of Set
 * members, and it keeps shared references. So the walk over an unchanged
 * copy takes the same steps as the walk over the original.
 */
function step(walk: Walk, next: Step, path: string): void {
	if (
		walk.original !== undefined &&
		walk.original[walk.steps.length] !== next
	) {
		throwChangedInCopy(walk.subject, path);
	}
	walk.steps.push(next);
}

function throwChangedInCopy(subject: string, path: string): never {
	throw new TypeError(
		`${subject}${path} changed in the copy; a built-in whose prototype was replaced loses its own properties in the copy, and a Proxy trap can change the graph; map it to plain data`,
	);
}

function assertDetachable(value: unknown, path: string, walk: Walk): void {
	if (typeof value === "function") {
		throw new TypeError(
			`${walk.subject}${path} is a function; map it to plain data`,
		);
	}
	// Guided rejection instead of the raw DataCloneError DOMException that
	// structuredClone throws for symbols, which no recovery channel catches.
	if (typeof value === "symbol") {
		throw new TypeError(
			`${walk.subject}${path} is a symbol; map it to plain data`,
		);
	}
	if (value === null || typeof value !== "object") return;
	const object = value as object;
	if (walk.seen.has(object)) return;
	walk.seen.add(object);

	if (Array.isArray(object)) {
		if (!hasIntrinsicPrototypeChain(object, "Array")) {
			throwClassInstance(object, path, walk.subject);
		}
		step(walk, ARRAY_STEP, path);
		assertOwnPropertiesDetachable(object, path, walk, "array");
		return;
	}

	const tag = builtInTagWithoutInvokingAccessors(object);
	if (tag !== undefined) {
		// The tag comes from the internal slot, so a subclass gets the same
		// message as its built-in.
		if (walk.rule === "freeze") assertFreezable(tag, path, walk.subject);
		if (!hasIntrinsicPrototypeChain(object)) {
			throwClassInstance(object, path, walk.subject);
		}
		step(walk, builtInStep(tag), path);
		if (tag === "[object Map]") {
			let index = 0;
			for (const [key, entry] of mapEntries.call(
				object as Map<unknown, unknown>,
			)) {
				assertDetachable(key, `${path}<map key #${index}>`, walk);
				assertDetachable(entry, `${path}<map value #${index}>`, walk);
				index++;
			}
		} else if (tag === "[object Set]") {
			let index = 0;
			for (const member of setValues.call(object as Set<unknown>)) {
				assertDetachable(member, `${path}<set member #${index}>`, walk);
				index++;
			}
		} else if (
			tag === "[object Promise]" ||
			tag === "[object WeakMap]" ||
			tag === "[object WeakSet]"
		) {
			throw new TypeError(
				`${walk.subject}${path} is a ${tag.slice(8, -1)} and cannot be detached`,
			);
		} else if (tag === "[object Error]") {
			throw new TypeError(
				`${walk.subject}${path} is an Error; map it to plain data`,
			);
		} else if (sharesMemory(object, tag)) {
			throw new TypeError(
				`${walk.subject}${path} is backed by a SharedArrayBuffer and the copy would share its memory; map it to plain data`,
			);
		}
		assertOwnPropertiesDetachable(object, path, walk, "built-in", tag);
		return;
	}

	const prototype = Object.getPrototypeOf(object);
	const isPlainRecord =
		prototype === null ||
		(isIntrinsicConstructorPrototype(prototype, "Object") &&
			Object.getPrototypeOf(prototype) === null);
	if (!isPlainRecord) {
		throwClassInstance(object, path, walk.subject);
	}
	step(walk, RECORD_STEP, path);
	assertOwnPropertiesDetachable(object, path, walk, "record");
}

/**
 * Audits the own properties the clone would copy or drop. The clone keeps
 * the enumerable own keys of a record and of an array, expandos included,
 * and drops every own key of another built-in. `length` on an array is
 * its own machinery, not data, and so are the keys that
 * {@link isBuiltInMachinery} names. The index keys of a built-in below its
 * content length are its content and pass as such. Another index key of a
 * built-in is an expando. `tag` is the tag of a built-in.
 */
function assertOwnPropertiesDetachable(
	object: object,
	path: string,
	walk: Walk,
	kind: "array" | "built-in" | "record",
	tag = "",
): void {
	const contentLength = kind === "built-in" ? contentLengthOf(object, tag) : 0;
	for (const key of Reflect.ownKeys(object)) {
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		if (descriptor === undefined) continue;
		if (typeof key === "symbol") {
			if (!descriptor.enumerable) continue;
			throw new TypeError(
				`${walk.subject}${path} has a symbol-keyed property; map it to plain data`,
			);
		}
		if (kind === "array" && key === "length") continue;
		const isIndex = INDEX_KEY.test(key);
		if (!descriptor.enumerable) {
			if (kind === "built-in" && isBuiltInMachinery(tag, key, descriptor)) {
				continue;
			}
			throw new TypeError(
				`${walk.subject}${path}.${key} is not enumerable and the clone would drop it; map it to plain data`,
			);
		}
		if (kind === "built-in" && isIndex && Number(key) < contentLength) {
			continue;
		}
		const memberPath = isIndex ? `${path}[${key}]` : `${path}.${key}`;
		if (!("value" in descriptor)) {
			throw new TypeError(
				`${walk.subject}${memberPath} is an accessor property; map it to plain data`,
			);
		}
		if (kind === "built-in") {
			throw new TypeError(
				`${walk.subject}${memberPath} is an expando on a ${constructorName(Object.getPrototypeOf(object)) ?? "built-in"} and the clone would drop it; map it to plain data`,
			);
		}
		step(walk, key, memberPath);
		assertDetachable(descriptor.value, memberPath, walk);
	}
}

/**
 * Whether an own non-enumerable property of a built-in is machinery, not
 * data: a function, for example a mutator shadow that `deepFreeze`
 * installs, the scan position of a RegExp, or the length of a boxed
 * String. The clone drops a function and rebuilds the other two from the
 * internal slots.
 */
function isBuiltInMachinery(
	tag: string,
	key: string,
	descriptor: PropertyDescriptor,
): boolean {
	return (
		typeof descriptor.value === "function" ||
		(tag === REGEXP_TAG && key === "lastIndex") ||
		(tag === "[object String]" && key === "length")
	);
}

/**
 * The number of index keys that hold the content of a built-in: the
 * elements of a typed array and the characters of a boxed String.
 */
function contentLengthOf(object: object, tag: string): number {
	if (tag === "[object TypedArray]") {
		return typedArrayLength.call(object as ArrayBufferView);
	}
	if (tag === "[object String]") return stringValueOf.call(object).length;
	return 0;
}

// The built-in readers read the internal slot, so an own `buffer` or
// `length` accessor of the state does not run.
const typedArrayLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"length",
)?.get as (this: ArrayBufferView) => number;
const stringValueOf = String.prototype.valueOf;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"buffer",
)?.get as (this: ArrayBufferView) => ArrayBufferLike;
const dataViewBuffer = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"buffer",
)?.get as (this: DataView) => ArrayBufferLike;

function sharesMemory(object: object, tag: string): boolean {
	if (tag === "[object SharedArrayBuffer]") return true;
	if (tag === "[object TypedArray]") {
		return isSharedArrayBuffer(
			typedArrayBuffer.call(object as ArrayBufferView),
		);
	}
	if (tag === "[object DataView]") {
		return isSharedArrayBuffer(dataViewBuffer.call(object as DataView));
	}
	return false;
}

function isSharedArrayBuffer(buffer: ArrayBufferLike): boolean {
	return (
		builtInTagWithoutInvokingAccessors(buffer) === "[object SharedArrayBuffer]"
	);
}

function assertFreezable(tag: string, path: string, subject: string): void {
	if (BINARY_DATA_TAGS.has(tag)) {
		throw new TypeError(
			`${subject}${path} is binary data; binary buffers (a typed array, a DataView, an ArrayBuffer, or a SharedArrayBuffer) stay mutable under freezing and JSON does not keep them; encode the data as a string, for example base64`,
		);
	}
	if (tag === REGEXP_TAG) {
		throw new TypeError(
			`${subject}${path} is a RegExp; a freeze cannot make it immutable, because compile() changes the pattern of a frozen RegExp before it throws, and a frozen global or sticky pattern throws on a match; keep its source and flags as strings`,
		);
	}
}

function throwClassInstance(
	object: object,
	path: string,
	subject: string,
): never {
	const name =
		constructorName(Object.getPrototypeOf(object)) ?? "anonymous class";
	throw new TypeError(
		`${subject}${path} is a class instance (${name}); map it to plain data`,
	);
}

/**
 * The name of the constructor of `prototype`, read through property
 * descriptors, so that no accessor runs.
 */
function constructorName(prototype: object | null): string | undefined {
	if (prototype === null) return undefined;
	const owner = Object.getOwnPropertyDescriptor(
		prototype,
		"constructor",
	)?.value;
	if (typeof owner !== "function") return undefined;
	const name = Object.getOwnPropertyDescriptor(owner, "name")?.value;
	return typeof name === "string" && name !== "" ? name : undefined;
}
