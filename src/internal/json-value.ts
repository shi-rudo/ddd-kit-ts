/** A primitive value represented without loss by JSON. */
export type JsonPrimitive = boolean | null | number | string;

/** A recursively JSON-safe value. Runtime validation rejects lossy shapes. */
export type JsonValue =
	| JsonPrimitive
	| ReadonlyArray<JsonValue>
	| { readonly [key: string]: JsonValue };

/** A JSON-safe object. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Non-null, non-array object shape check shared by the message boundaries. */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type InvalidJsonValue = (path: string, reason: string) => never;

/**
 * Proves that JSON serialization preserves a value exactly.
 *
 * The caller owns the boundary-specific error type through `invalid`.
 */
export function assertJsonValue(
	value: unknown,
	path: string,
	invalid: InvalidJsonValue,
	active = new WeakSet<object>(),
): asserts value is JsonValue {
	if (value === null) return;
	switch (typeof value) {
		case "string":
		case "boolean":
			return;
		case "number":
			if (!Number.isFinite(value)) {
				return invalid(path, "numbers must be finite JSON numbers");
			}
			// JSON.stringify(-0) produces "0", so negative zero does not
			// round-trip; rejecting it keeps the exactness contract honest.
			if (Object.is(value, -0)) {
				return invalid(path, "negative zero changes to 0 in JSON");
			}
			return;
		case "object":
			break;
		default:
			invalid(path, `value of type ${typeof value} is not JSON-safe`);
	}

	if (active.has(value)) {
		invalid(path, "cyclic references are not JSON-safe");
	}
	active.add(value);
	if (Array.isArray(value)) {
		for (const key of Reflect.ownKeys(value)) {
			if (key === "length") continue;
			if (typeof key === "symbol") {
				invalid(path, "symbol-keyed array properties would be dropped by JSON");
			}
			const index = Number(key);
			if (
				!Number.isInteger(index) ||
				index < 0 ||
				index >= value.length ||
				String(index) !== key
			) {
				invalid(
					`${path}.${key}`,
					"named array properties would be dropped by JSON",
				);
			}
		}
		for (let index = 0; index < value.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(value, index);
			if (descriptor === undefined) {
				invalid(
					`${path}[${index}]`,
					"sparse array holes would change to null in JSON",
				);
			}
			if (!("value" in descriptor) || !descriptor.enumerable) {
				invalid(
					`${path}[${index}]`,
					"accessor and non-enumerable array elements are not JSON-safe",
				);
			}
			assertJsonValue(descriptor.value, `${path}[${index}]`, invalid, active);
		}
		active.delete(value);
		return;
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		invalid(
			path,
			"Date, Map, Set, and class instances are not JSON-safe here; map " +
				"them explicitly to strings, arrays, or plain objects",
		);
	}
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === "symbol") {
			invalid(path, "symbol-keyed properties would be dropped by JSON");
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined) continue;
		const childPath = `${path}.${key}`;
		if (key === "__proto__") {
			invalid(
				childPath,
				"hostile __proto__ keys are not accepted at integration boundaries",
			);
		}
		if (!("value" in descriptor) || !descriptor.enumerable) {
			invalid(
				childPath,
				"accessor and non-enumerable properties are not JSON-safe",
			);
		}
		assertJsonValue(descriptor.value, childPath, invalid, active);
	}
	active.delete(value);
}
