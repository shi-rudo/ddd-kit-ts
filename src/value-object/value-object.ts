import { deepEqual } from "../utils/array/deep-equal";
import {
    deepEqualExcept,
    type DeepEqualExceptOptions,
} from "../utils/array/deep-equal-except";
import { isBuiltInObject } from "../utils/array/is-built-in";
import { err, ok, type Result } from "@shirudo/result";

// ============================================================================
// Functional Value Object API
// ============================================================================

export type VO<T> = Readonly<T>;

/**
 * `Object.freeze` does not protect internal slots: a frozen Date still
 * accepts `setTime`, a frozen Map still accepts `set`. To make the
 * "deeply immutable" guarantee real, the mutator methods are shadowed
 * with own throwing functions BEFORE the freeze. The shadows are
 * non-enumerable, so they are invisible to `Object.keys`/spread (deep
 * equality is unaffected) and `structuredClone` drops them (a `vo()`
 * round-trip never sees them).
 */
const DATE_MUTATORS: readonly string[] = [
    "setTime",
    "setMilliseconds",
    "setUTCMilliseconds",
    "setSeconds",
    "setUTCSeconds",
    "setMinutes",
    "setUTCMinutes",
    "setHours",
    "setUTCHours",
    "setDate",
    "setUTCDate",
    "setMonth",
    "setUTCMonth",
    "setFullYear",
    "setUTCFullYear",
    "setYear",
];

function shadowMutators(
    obj: object,
    typeName: string,
    methods: readonly string[],
): void {
    // A non-extensible built-in (frozen, sealed, or preventExtensions'd)
    // cannot receive shadow properties — skip it (best effort; the caller
    // chose to lock it themselves).
    if (!Object.isExtensible(obj)) return;
    for (const method of methods) {
        Object.defineProperty(obj, method, {
            value: function throwFrozenMutation(): never {
                throw new TypeError(
                    `Cannot call ${method}() on a ${typeName} inside a deeply frozen value`,
                );
            },
            writable: false,
            enumerable: false,
            configurable: false,
        });
    }
}

/**
 * Deep freezes an object and all its nested properties recursively, then
 * returns it. Iterates both string-keyed and symbol-keyed own properties
 * so the freeze symmetry matches `deepEqual` (which also considers symbol
 * keys). Handles circular references by tracking visited objects.
 *
 * Note: `deepFreeze` mutates its argument in place — it sets `[[Frozen]]`
 * on the object you pass in. Callers that need to avoid touching the
 * input (e.g. `vo()`) should deep-clone first.
 *
 * Date/Map/Set keep internal-slot mutability under `Object.freeze`
 * (`setTime`, `set`, `add`, … still work on frozen instances), so their
 * mutator methods are shadowed with throwing own properties and Map/Set
 * contents are frozen recursively. The shadows are non-enumerable —
 * invisible to `Object.keys`, spread, `deepEqual`, and `structuredClone`.
 *
 * Limitation: ArrayBuffer views (TypedArrays, DataView) are passed through
 * unfrozen — the spec forbids freezing a view with elements, and freezing
 * cannot protect the underlying buffer. Their contents remain mutable.
 */
export function deepFreeze<T>(obj: T, visited = new WeakSet<object>()): Readonly<T> {
    if (obj === null || typeof obj !== "object") {
        return obj as Readonly<T>;
    }
    // ArrayBuffer views are atomic: Object.freeze on a typed array with
    // elements throws per spec, and freezing cannot protect the underlying
    // buffer anyway — so views are returned as-is (their contents stay
    // mutable). Mirrors deepEqual, which also treats views atomically.
    if (ArrayBuffer.isView(obj)) {
        return obj as Readonly<T>;
    }
    if (visited.has(obj as object)) {
        return obj as Readonly<T>;
    }
    visited.add(obj as object);

    // Date/Map/Set keep internal-slot mutability under Object.freeze —
    // shadow their mutators and freeze Map/Set contents (entries are not
    // own keys, so the key walk below would miss them). Brand-verified via
    // isBuiltInObject: a plain object spoofing one of these tags through
    // Symbol.toStringTag is just frozen as a plain object.
    const tag = Object.prototype.toString.call(obj);
    if (isBuiltInObject(obj as object, tag)) {
        if (tag === "[object Date]") {
            shadowMutators(obj as object, "Date", DATE_MUTATORS);
        } else if (tag === "[object Map]") {
            for (const [key, value] of obj as unknown as Map<
                unknown,
                unknown
            >) {
                deepFreeze(key, visited);
                deepFreeze(value, visited);
            }
            shadowMutators(obj as object, "Map", ["set", "delete", "clear"]);
        } else if (tag === "[object Set]") {
            for (const member of obj as unknown as Set<unknown>) {
                deepFreeze(member, visited);
            }
            shadowMutators(obj as object, "Set", ["add", "delete", "clear"]);
        }
    }

    // Reflect.ownKeys returns both string and symbol own keys.
    const keys = Reflect.ownKeys(obj);
    for (const key of keys) {
        const value = (obj as Record<string | symbol, unknown>)[key];
        if (value !== null && typeof value === "object") {
            deepFreeze(value, visited);
        }
    }

    return Object.freeze(obj) as Readonly<T>;
}

/**
 * Deep clone used by `vo()` and the `ValueObject` constructor.
 *
 * Plain objects, class instances (prototype-preserving — the constructor
 * is NOT re-invoked), arrays, and Map/Set entries are walked manually so
 * that symbol-keyed properties survive (which `structuredClone` silently
 * drops — they would otherwise be invisible to `voEquals`, whose
 * `deepEqual` DOES consider symbol keys) and shared references / cycles
 * keep their identity across Map/Set boundaries. Function values throw,
 * preserving `vo()`'s documented data-not-behaviour gate; Promise /
 * WeakMap / WeakSet throw a descriptive `TypeError` (they have no
 * meaningful value semantics). Atomic built-ins (Date, RegExp,
 * TypedArrays, ArrayBuffer, wrappers, Error) delegate to
 * `structuredClone`, brand-verified so a `Symbol.toStringTag` spoofer is
 * walked as the plain object it is. `__proto__` own keys are copied as
 * inert data properties.
 */
function cloneForVo(value: unknown, visited: WeakMap<object, unknown>): unknown {
    if (typeof value === "function") {
        throw new TypeError(
            "vo() does not accept function values — Value Objects are data, not behaviour",
        );
    }
    if (value === null || typeof value !== "object") {
        return value;
    }
    const obj = value as object;
    if (visited.has(obj)) {
        return visited.get(obj);
    }

    if (Array.isArray(obj)) {
        const clone: unknown[] = new Array(obj.length);
        visited.set(obj, clone);
        for (let i = 0; i < obj.length; i++) {
            clone[i] = cloneForVo(obj[i], visited);
        }
        return clone;
    }

    const tag = Object.prototype.toString.call(obj);
    if (isBuiltInObject(obj, tag)) {
        if (tag === "[object Map]") {
            const clone = new Map<unknown, unknown>();
            visited.set(obj, clone);
            for (const [key, entry] of obj as Map<unknown, unknown>) {
                clone.set(cloneForVo(key, visited), cloneForVo(entry, visited));
            }
            return clone;
        }
        if (tag === "[object Set]") {
            const clone = new Set<unknown>();
            visited.set(obj, clone);
            for (const member of obj as Set<unknown>) {
                clone.add(cloneForVo(member, visited));
            }
            return clone;
        }
        if (
            tag === "[object Promise]" ||
            tag === "[object WeakMap]" ||
            tag === "[object WeakSet]"
        ) {
            throw new TypeError(
                `vo() cannot clone a ${tag.slice(8, -1)} — Value Objects are plain data`,
            );
        }
        // Atomic built-ins: Date, RegExp, TypedArrays, ArrayBuffer,
        // wrappers, Error.
        const builtInClone = structuredClone(obj);
        visited.set(obj, builtInClone);
        return builtInClone;
    }

    // Plain objects AND class instances: prototype-preserving key walk.
    const clone = Object.create(Object.getPrototypeOf(obj));
    visited.set(obj, clone);
    for (const key of Reflect.ownKeys(obj)) {
        const descriptor = Object.getOwnPropertyDescriptor(obj, key);
        if (!descriptor?.enumerable) continue;
        // defineProperty (not assignment) so an own "__proto__" key can
        // never invoke the prototype setter.
        Object.defineProperty(clone, key, {
            value: cloneForVo(
                (obj as Record<PropertyKey, unknown>)[key],
                visited,
            ),
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }
    return clone;
}

/**
 * Creates a deeply immutable value object from the given data.
 *
 * The input is first deep-cloned, then the clone is frozen — so calling
 * `vo(input)` never freezes the caller's own object graph as a
 * side-effect. Mutating the input afterwards does not bleed into the VO.
 * Symbol-keyed properties are preserved (matching `voEquals`); function
 * values are rejected (Value Objects are data, not behaviour).
 *
 * @example
 * ```typescript
 * const nested = { lat: 52.5, lng: 13.4 };
 * const address = vo({ street: "Main St", coordinates: nested });
 * address.coordinates.lat = 99; // ❌ Cannot assign to read-only property
 * nested.lat = 0;               // ✅ caller's input still mutable
 * ```
 */
export function vo<T>(t: T): VO<T> {
    return deepFreeze(cloneForVo(t, new WeakMap()) as T);
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
     * The properties are deep-cloned (prototype-preserving) and then deeply
     * frozen — the caller's own object graph is never frozen or mutated,
     * and later mutation of the input does not bleed into the value object.
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
        // Same clone as vo(): prototype-preserving, Map/Set contents
        // walked (so the caller's entries are never frozen or shadowed in
        // place), function values rejected. A shallow `{ ...props }` or
        // deepOmit (which aliases reference-compared built-ins by design)
        // would let deepFreeze reach caller-owned objects.
        this.props = deepFreeze(cloneForVo(props, new WeakMap()) as T);
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
