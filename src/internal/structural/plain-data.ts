import { PrototypePollutionError } from "../../errors/kit-errors";

/** Options for {@link copyPlainData}. */
export interface CopyPlainDataOptions {
	/** Names the value at the start of every message, for example `createEvent: payload`. */
	readonly subject: string;
	/**
	 * Keeps an object by reference instead of copying it. The walk does not
	 * enter such an object. A value object keeps a nested value object this
	 * way.
	 */
	readonly keepByReference?: (value: object) => boolean;
}

/**
 * Returns a copy of `value` under the plain-data rule of the kit (see "One
 * rule for plain data" in the design decisions). One walk builds the copy
 * and checks each value as it copies it. A value outside the rule throws a
 * `TypeError` that names the path. An own `__proto__` key throws
 * `PrototypePollutionError`. Cycles and shared references survive the copy.
 * The copy holds objects of the local realm only.
 */
export function copyPlainData<T>(value: T, options: CopyPlainDataOptions): T {
	const walk: Walk = {
		subject: options.subject,
		keepByReference: options.keepByReference,
		copies: new Map(),
		path: [],
	};
	return copyValue(value, walk) as T;
}

interface Walk {
	readonly subject: string;
	readonly keepByReference: ((value: object) => boolean) | undefined;
	/** The copy of each object that the walk entered, by original. */
	readonly copies: Map<object, unknown>;
	/** The keys from the root to the current value, formatted on demand. */
	readonly path: string[];
}

const objectToString = Object.prototype.toString;
const isEnumerable = Object.prototype.propertyIsEnumerable;
const INDEX_KEY = /^(0|[1-9]\d*)$/;

function copyValue(value: unknown, walk: Walk): unknown {
	if (typeof value === "function") {
		reject(walk, "is a function; map it to plain data");
	}
	if (typeof value === "symbol") {
		reject(walk, "is a symbol; map it to plain data");
	}
	if (value === null || typeof value !== "object") return value;

	const copied = walk.copies.get(value);
	if (copied !== undefined) return copied;
	if (walk.keepByReference?.(value)) return value;

	if (Array.isArray(value)) {
		if (!hasBuiltInPrototypeChain(value)) rejectClassInstance(value, walk);
		const copy: unknown[] = new Array(value.length);
		walk.copies.set(value, copy);
		copyOwnProperties(value, copy, walk);
		return copy;
	}

	const prototype: object | null = Object.getPrototypeOf(value);
	if (prototype === null || Object.getPrototypeOf(prototype) === null) {
		const copy: Record<string, unknown> =
			prototype === null ? Object.create(null) : {};
		walk.copies.set(value, copy);
		copyOwnProperties(value, copy, walk);
		return copy;
	}

	const tag = objectToString.call(value);
	if (!hasBuiltInPrototypeChain(value) || !COPIED_TAGS.has(tag)) {
		rejectObject(value, tag, walk);
	}
	if (tag === "[object Date]") {
		const copy = new Date((value as Date).getTime());
		walk.copies.set(value, copy);
		return copy;
	}
	if (tag === "[object Map]") {
		const copy = new Map<unknown, unknown>();
		walk.copies.set(value, copy);
		let index = 0;
		for (const [key, entry] of value as Map<unknown, unknown>) {
			walk.path.push(`<map key #${index}>`);
			const copiedKey = copyPrimitiveMember(key, walk);
			walk.path.pop();
			walk.path.push(`<map value #${index}>`);
			copy.set(copiedKey, copyValue(entry, walk));
			walk.path.pop();
			index += 1;
		}
		return copy;
	}
	const copy = new Set<unknown>();
	walk.copies.set(value, copy);
	let index = 0;
	for (const member of value as Set<unknown>) {
		walk.path.push(`<set member #${index}>`);
		copy.add(copyPrimitiveMember(member, walk));
		walk.path.pop();
		index += 1;
	}
	return copy;
}

const COPIED_TAGS: ReadonlySet<string> = new Set([
	"[object Date]",
	"[object Map]",
	"[object Set]",
]);

/**
 * Whether the prototype chain of `value` has exactly two links, as an
 * array, a `Date`, a `Map`, or a `Set` of any realm has: its own prototype,
 * then `Object.prototype`. A subclass adds a link.
 */
function hasBuiltInPrototypeChain(value: object): boolean {
	const prototype = Object.getPrototypeOf(value);
	const base = prototype === null ? null : Object.getPrototypeOf(prototype);
	return base !== null && Object.getPrototypeOf(base) === null;
}

/**
 * Copies the own properties of a record or an array. The `length` of an
 * array is its own machinery. A non-enumerable symbol key is metadata by
 * convention, and the copy leaves it out.
 */
function copyOwnProperties(
	source: object,
	target: Record<string, unknown> | unknown[],
	walk: Walk,
): void {
	const isArray = Array.isArray(source);
	for (const key of Reflect.ownKeys(source)) {
		if (typeof key === "symbol") {
			if (isEnumerable.call(source, key)) {
				reject(walk, "has a symbol-keyed property; map it to plain data");
			}
			continue;
		}
		if (isArray && key === "length") continue;
		if (key === "__proto__") {
			throw new PrototypePollutionError(key, `${walk.subject}${pathOf(walk)}`);
		}
		walk.path.push(key);
		const descriptor = Object.getOwnPropertyDescriptor(
			source,
			key,
		) as PropertyDescriptor;
		if (!("value" in descriptor)) {
			reject(walk, "is an accessor property; map it to plain data");
		}
		if (!descriptor.enumerable) {
			reject(
				walk,
				"is not enumerable, and the copy would drop it; map it to plain data",
			);
		}
		(target as Record<string, unknown>)[key] = copyValue(
			descriptor.value,
			walk,
		);
		walk.path.pop();
	}
}

/**
 * A `Map` and a `Set` compare their keys by identity, and a copy cannot
 * keep the identity of an object. So a key or a member must be a primitive.
 */
function copyPrimitiveMember(member: unknown, walk: Walk): unknown {
	if (member !== null && typeof member === "object") {
		reject(
			walk,
			"is an object; a Map key or a Set member must be a primitive, because a copy cannot keep the identity of an object",
		);
	}
	return copyValue(member, walk);
}

const REJECTION_HINTS: Readonly<Record<string, string>> = {
	"[object RegExp]": "keep its source and flags as strings",
	"[object Error]": "keep its code and its message as strings",
	"[object Boolean]": "use the primitive value",
	"[object Number]": "use the primitive value",
	"[object String]": "use the primitive value",
	"[object BigInt]": "use the primitive value",
};

function rejectObject(value: object, tag: string, walk: Walk): never {
	if (
		ArrayBuffer.isView(value) ||
		tag === "[object ArrayBuffer]" ||
		tag === "[object SharedArrayBuffer]"
	) {
		reject(
			walk,
			"is binary data; encode the bytes as a string, for example base64",
		);
	}
	if (tag === "[object Object]" || !hasBuiltInPrototypeChain(value)) {
		rejectClassInstance(value, walk);
	}
	const name = tag.slice(8, -1);
	const article = /^[AEIOU]/.test(name) ? "an" : "a";
	const hint = REJECTION_HINTS[tag] ?? "map it to plain data";
	reject(walk, `is ${article} ${name}; ${hint}`);
}

function rejectClassInstance(value: object, walk: Walk): never {
	const name = (
		Object.getPrototypeOf(value)?.constructor as { name?: unknown } | undefined
	)?.name;
	const described =
		typeof name === "string" && name !== "" ? name : "anonymous class";
	reject(walk, `is a class instance (${described}); map it to plain data`);
}

function reject(walk: Walk, reason: string): never {
	throw new TypeError(`${walk.subject}${pathOf(walk)} ${reason}`);
}

function pathOf(walk: Walk): string {
	return walk.path
		.map((key) =>
			key.startsWith("<") ? key : INDEX_KEY.test(key) ? `[${key}]` : `.${key}`,
		)
		.join("");
}
