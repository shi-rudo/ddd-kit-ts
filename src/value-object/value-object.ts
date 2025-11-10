import { err, ok, type Result } from "../core/result";

export type ValueObject<T> = Readonly<T>;

/**
 * Deep freezes an object and all its nested properties recursively.
 * This ensures true immutability for value objects with nested structures.
 * Handles circular references by tracking visited objects.
 */
function deepFreeze<T>(obj: T, visited = new WeakSet<object>()): Readonly<T> {
	// Handle null and non-objects
	if (obj === null || typeof obj !== "object") {
		return obj as Readonly<T>;
	}

	// Handle circular references
	if (visited.has(obj as object)) {
		return obj as Readonly<T>;
	}

	// Mark as visited
	visited.add(obj as object);

	// Retrieve the property names defined on obj
	const propNames = Object.getOwnPropertyNames(obj);

	// Freeze properties before freezing self
	for (const name of propNames) {
		const value = (obj as Record<string, unknown>)[name];

		// Freeze value if it is an object or array
		if (value && (typeof value === "object" || Array.isArray(value))) {
			deepFreeze(value, visited);
		}
	}

	return Object.freeze(obj) as Readonly<T>;
}

/**
 * Creates a deeply immutable value object from the given data.
 * All nested objects and arrays are frozen recursively.
 *
 * @param t - The data to convert into a value object
 * @returns A deeply frozen, immutable value object
 *
 * @example
 * ```typescript
 * const address = vo({
 *   street: "Main St",
 *   city: "Berlin",
 *   coordinates: { lat: 52.5, lng: 13.4 }
 * });
 * // address.coordinates.lat = 99; // ❌ Error: Cannot assign to read-only property
 * ```
 */
export function vo<T>(t: T): ValueObject<T> {
	return deepFreeze({ ...t });
}

/**
 * Compares two value objects for equality based on their values.
 * Uses deep equality comparison by serializing both objects to JSON.
 *
 * Note: This is a simple implementation. For production use with complex objects,
 * consider using a more robust deep equality library or implementing custom equality logic.
 *
 * @param a - First value object
 * @param b - Second value object
 * @returns true if both objects have the same values, false otherwise
 *
 * @example
 * ```typescript
 * const money1 = vo({ amount: 100, currency: "USD" });
 * const money2 = vo({ amount: 100, currency: "USD" });
 * voEquals(money1, money2); // true
 * ```
 */
export function voEquals<T>(a: ValueObject<T>, b: ValueObject<T>): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Creates a value object with optional validation.
 * Returns a Result type instead of throwing an error.
 *
 * @param t - The data to convert into a value object
 * @param validate - Validation function that returns true if valid
 * @param errorMessage - Optional custom error message if validation fails
 * @returns Result containing the value object if valid, or an error message if validation fails
 *
 * @example
 * ```typescript
 * const result = voWithValidation(
 *   { amount: 100, currency: "USD" },
 *   (m) => m.amount >= 0 && m.currency.length === 3,
 *   "Invalid money: amount must be non-negative and currency must be 3 characters"
 * );
 *
 * if (result.ok) {
 *   console.log(result.value); // Use the value object
 * } else {
 *   console.error(result.error); // Handle validation error
 * }
 * ```
 */
export function voWithValidation<T>(
	t: T,
	validate: (value: T) => boolean,
	errorMessage?: string,
): Result<ValueObject<T>, string> {
	if (!validate(t)) {
		return err(
			errorMessage ?? `Validation failed for value object: ${JSON.stringify(t)}`,
		);
	}
	return ok(vo(t));
}

/**
 * Creates a value object with optional validation.
 * Throws an error if validation fails.
 *
 * @param t - The data to convert into a value object
 * @param validate - Validation function that returns true if valid
 * @param errorMessage - Optional custom error message if validation fails
 * @returns A deeply frozen, immutable value object
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * const money = voWithValidationUnsafe(
 *   { amount: 100, currency: "USD" },
 *   (m) => m.amount >= 0 && m.currency.length === 3,
 *   "Invalid money: amount must be non-negative and currency must be 3 characters"
 * );
 * ```
 */
export function voWithValidationUnsafe<T>(
	t: T,
	validate: (value: T) => boolean,
	errorMessage?: string,
): ValueObject<T> {
	if (!validate(t)) {
		throw new Error(
			errorMessage ?? `Validation failed for value object: ${JSON.stringify(t)}`,
		);
	}
	return vo(t);
}
