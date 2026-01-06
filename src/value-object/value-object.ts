import { deepEqual } from "../utils/array/deep-equal";
import {
    deepEqualExcept,
    type DeepEqualExceptOptions,
} from "../utils/array/deep-equal-except";
import { err, ok, type Result } from "../core/result";

// ============================================================================
// Functional Value Object API
// ============================================================================

export type VO<T> = Readonly<T>;

/**
 * Deep freezes an object and all its nested properties recursively.
 * This ensures true immutability for value objects with nested structures.
 * Handles circular references by tracking visited objects.
 */
export function deepFreeze<T>(obj: T, visited = new WeakSet<object>()): Readonly<T> {
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
export function vo<T>(t: T): VO<T> {
    return deepFreeze({ ...t });
}

/**
 * Compares two value objects for equality based on their values.
 * Uses deep equality comparison that handles:
 * - Nested objects and arrays
 * - Primitives (including NaN)
 * - Dates, Maps, Sets, RegExp
 * - TypedArrays and DataView
 * - Symbol keys
 * - Circular references
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
 *
 * const address1 = vo({
 *   street: "Main St",
 *   coordinates: { lat: 52.5, lng: 13.4 }
 * });
 * const address2 = vo({
 *   street: "Main St",
 *   coordinates: { lat: 52.5, lng: 13.4 }
 * });
 * voEquals(address1, address2); // true
 * ```
 */
export function voEquals<T>(a: VO<T>, b: VO<T>): boolean {
    return deepEqual(a, b);
}

/**
 * Compares two value objects for equality while ignoring specified keys.
 * Useful for comparing value objects that contain metadata or optional fields
 * that should not affect equality comparison.
 *
 * @param a - First value object
 * @param b - Second value object
 * @param options - Options specifying which keys to ignore during comparison
 * @returns true if both objects have the same values (after ignoring specified keys), false otherwise
 *
 * @example
 * ```typescript
 * // Value object with metadata
 * const address1 = vo({
 *   street: "Main St",
 *   city: "Berlin",
 *   metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-02" }
 * });
 *
 * const address2 = vo({
 *   street: "Main St",
 *   city: "Berlin",
 *   metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-03" }
 * });
 *
 * // Compare ignoring metadata timestamps
 * voEqualsExcept(address1, address2, {
 *   ignoreKeys: ["updatedAt"],
 *   ignoreKeyPredicate: (key, path) => path.includes("metadata")
 * }); // true
 *
 * // Compare ignoring all metadata
 * voEqualsExcept(address1, address2, {
 *   ignoreKeyPredicate: (key, path) => path.includes("metadata")
 * }); // true
 * ```
 */
export function voEqualsExcept<T>(
    a: VO<T>,
    b: VO<T>,
    options: DeepEqualExceptOptions,
): boolean {
    return deepEqualExcept(a, b, options);
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
): Result<VO<T>, string> {
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
): VO<T> {
    if (!validate(t)) {
        throw new Error(
            errorMessage ?? `Validation failed for value object: ${JSON.stringify(t)}`,
        );
    }
    return vo(t);
}

// ============================================================================
// Class-based Value Object API
// ============================================================================

/**
 * Interface for Value Objects.
 * Value Objects are immutable and defined by their properties.
 *
 * @template T - The shape of the value object's properties
 */
export interface IValueObject<T extends object> {
    /**
     * The immutable properties of the value object.
     */
    readonly props: Readonly<T>;

    /**
     * Checks if this value object is equal to another.
     * Uses deep equality comparison on the properties.
     *
     * @param other - The other value object to compare
     * @returns true if the properties are deeply equal
     */
    equals(other: IValueObject<T>): boolean;

    /**
     * Creates a clone of the value object with optional property overrides.
     *
     * @param props - Optional properties to override
     * @returns A new instance of the value object
     */
    clone(props?: Partial<T>): IValueObject<T>;

    /**
     * Serializes the value object to its raw properties for JSON operations.
     *
     * @returns The raw properties object
     */
    toJSON(): Readonly<T>;
}

/**
 * Abstract base class for creating Value Objects.
 * Value Objects are immutable and defined by their properties.
 *
 * @template T - The shape of the value object's properties
 */
export abstract class ValueObject<T extends object> implements IValueObject<T> {
    public readonly props: Readonly<T>;

    /**
     * Creates a new ValueObject.
     * The properties are deeply frozen to ensure immutability.
     *
     * @param props - The properties of the value object
     * @example
     * ```ts
     * class Money extends ValueObject<{ amount: number; currency: string }> {
     *   constructor(props: { amount: number; currency: string }) {
     *     super(props);
     *   }
     *
     *   protected validate(props: { amount: number; currency: string }): void {
     *     if (props.amount < 0) throw new Error("Amount cannot be negative");
     *   }
     * }
     * ```
     */
    constructor(props: T) {
        this.validate(props);
        this.props = deepFreeze({ ...props });
    }

    /**
     * Optional validation hook that can be overridden by subclasses.
     * Should throw an error if validation fails.
     *
     * @param props - The properties to validate
     * @throws Error if validation fails
     */
    protected validate(props: T): void {
        // Default implementation does nothing
    }

    /**
     * Checks if this value object is equal to another.
     * Uses deep equality comparison on the properties and checks for constructor equality.
     *
     * @param other - The other value object to compare
     * @returns true if the properties are deeply equal and constructors match
     */
    public equals(other: ValueObject<T>): boolean {
        if (other === null || other === undefined) {
            return false;
        }

        if (this.constructor !== other.constructor) {
            return false;
        }

        return deepEqual(this.props, other.props);
    }

    /**
     * Creates a clone of the value object with optional property overrides.
     *
     * @param props - Optional properties to override
     * @returns A new instance of the value object
     */
    public clone(props?: Partial<T>): this {
        const Constructor = this.constructor as new (props: T) => this;
        return new Constructor({ ...this.props, ...(props || {}) });
    }

    /**
     * Serializes the value object to its raw properties for JSON operations.
     *
     * @returns The raw properties object
     */
    public toJSON(): Readonly<T> {
        return this.props;
    }


}
