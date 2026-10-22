import { err, ok, type Result } from "@shirudo/result";
import {
	assertNotFromAnotherKitCopy,
	markKitCopy,
} from "../../internal/kit-copy";
import { deepEqual } from "../../internal/structural/deep-equal";
import { deepEqualExcept } from "../../internal/structural/deep-equal-except";
import { builtInTag } from "../../internal/structural/is-built-in";
import { copyPlainData } from "../../internal/structural/plain-data";
import { installMutatorShadows } from "../../internal/structural/shadowed-mutators";

// ============================================================================
// Functional Value Object API
// ============================================================================

export type ValueObjectOf<T> = Readonly<T>;

// A nested value object keeps all of its state in `props`: the props copy
// rejects an instance with an own field outside `props`. The data gates
// never see the own fields of a subclass, and deepEqual counts them. An
// open field would let ungated or mutable state into the value, and nested
// equality would differ from `equals`. With that rule the deepFreeze walk
// that follows the copy freezes the instance in place and reaches nothing
// but its own sealed props.
function isValueObjectInstance(value: unknown): value is ValueObject<object> {
	return value instanceof ValueObject;
}

function openValueObjectKeys(instance: object): string[] {
	return Object.keys(instance).filter((key) => key !== "props");
}

function rejectValueObjectAsInput(input: unknown, entry: string): void {
	if (isValueObjectInstance(input)) {
		throw new TypeError(
			`${entry} does not accept a value object as its input: nest the value object under a key, or pass its props`,
		);
	}
}

/**
 * Deep freezes an object and all its nested properties recursively, then
 * returns it. Iterates both string-keyed and symbol-keyed own properties
 * so the freeze symmetry matches `deepEqual` (which also considers symbol
 * keys). Handles circular references by tracking visited objects.
 *
 * Note: `deepFreeze` mutates its argument in place; it sets `[[Frozen]]`
 * on the object you pass in. Callers that need to avoid touching the
 * input (e.g. `valueObject()`) should deep-clone first.
 *
 * Date/Map/Set keep internal-slot mutability under `Object.freeze`
 * (`setTime`, `set`, `add`, … still work on frozen instances), so their
 * mutator methods are shadowed with throwing own properties and Map/Set
 * contents are frozen recursively. The shadows are non-enumerable:
 * invisible to `Object.keys`, spread, `deepEqual`, and `structuredClone`.
 *
 * The shadowing is deny-by-enumeration: only the mutators known at
 * release time are blocked. If the runtime grows a NEW mutator (e.g. the
 * stage-3 `Map.prototype.getOrInsert` upsert proposal), it is not blocked
 * until the list is updated. Treat the mutator blocking as a guard rail,
 * not a security boundary. A built-in that the caller froze before cannot
 * take the shadows, so its mutators keep working.
 *
 * Two kinds of built-in pass through unfrozen. ArrayBuffer views
 * (TypedArrays, DataView): the spec forbids freezing a view with elements,
 * and a freeze cannot protect the underlying buffer, so their contents stay
 * mutable. RegExp: pattern and flags live in immutable internal slots, and
 * the only own data property, `lastIndex`, is scan state that every global
 * or sticky match writes. A frozen RegExp protects nothing and throws on
 * the first such match, so the RegExp keeps matching instead. A view or a
 * RegExp passes through whole: an expando property on it stays open, and
 * the walk does not enter its subtree.
 */
// Every object that a deep freeze entered. A later walk stops at such an
// object, so a state written as `{ ...state, status }` costs the root
// object, not the whole graph. The walk marks an object before it
// descends, so a cycle ends at the mark.
const DEEP_FROZEN = new WeakSet<object>();

export function deepFreeze<T>(obj: T): Readonly<T> {
	freezeDeep(obj);
	return obj as Readonly<T>;
}

function freezeDeep(obj: unknown): void {
	if (obj === null || typeof obj !== "object" || DEEP_FROZEN.has(obj)) {
		return;
	}
	// A view and a RegExp pass through whole; see the deepFreeze doc.
	if (ArrayBuffer.isView(obj)) return;
	const tag = builtInTag(obj);
	if (tag === "[object RegExp]") return;
	DEEP_FROZEN.add(obj);

	// Date/Map/Set keep internal-slot mutability under Object.freeze:
	// shadow their mutators and freeze Map/Set contents (entries are not
	// own keys, so the key walk below would miss them).
	if (tag === "[object Map]") {
		for (const [key, value] of obj as Map<unknown, unknown>) {
			freezeDeep(key);
			freezeDeep(value);
		}
	} else if (tag === "[object Set]") {
		for (const member of obj as Set<unknown>) freezeDeep(member);
	}
	if (
		tag === "[object Date]" ||
		tag === "[object Map]" ||
		tag === "[object Set]"
	) {
		installMutatorShadows(obj, tag);
	}

	// Reflect.ownKeys returns both string and symbol own keys.
	for (const key of Reflect.ownKeys(obj)) {
		freezeDeep((obj as Record<string | symbol, unknown>)[key]);
	}
	Object.freeze(obj);
}

/**
 * Copies the props of `valueObject()` and of the `ValueObject` constructor
 * under the plain-data rule of the kit, so the deep freeze that follows
 * never reaches the caller's objects. A nested kit `ValueObject` is kept by
 * reference; it must keep all of its state in `props`.
 */
function copyValueObjectProps<T>(props: T, entry: string): T {
	return copyPlainData(props, {
		subject: `${entry}: props`,
		keepByReference: keepNestedValueObject,
	});
}

function keepNestedValueObject(value: object): boolean {
	if (!isValueObjectInstance(value)) {
		assertNotFromAnotherKitCopy(value, "The nested value object");
		return false;
	}
	const openKeys = openValueObjectKeys(value);
	if (openKeys.length > 0) {
		throw new TypeError(
			`valueObject() cannot nest a value object with own fields outside props (${openKeys.map(String).join(", ")}): keep the state of a value object in props`,
		);
	}
	return true;
}

/**
 * Creates a deeply immutable value object from the given data.
 *
 * The input is first copied, then the copy is frozen, so calling
 * `valueObject(input)` never freezes the caller's own object graph as a
 * side-effect. Mutating the input afterwards does not bleed into the value object.
 * The copy follows the plain-data rule of the kit (records, arrays, `Date`,
 * `Map`, `Set`, and primitives; see the design decisions) and throws a
 * `TypeError` that names the path for any other value, for example a
 * function, a class instance, or a `RegExp`. A kit `ValueObject` instance
 * nested in the input is kept by reference and frozen in place; it must
 * keep all of its state in `props`. A value object as the input itself is
 * rejected.
 *
 * @example
 * ```typescript
 * const nested = { lat: 52.5, lng: 13.4 };
 * const address = valueObject({ street: "Main St", coordinates: nested });
 * address.coordinates.lat = 99; // ❌ Cannot assign to read-only property
 * nested.lat = 0;               // ✅ caller's input still mutable
 * ```
 */
export function valueObject<T>(t: T): ValueObjectOf<T> {
	rejectValueObjectAsInput(t, "valueObject()");
	return deepFreeze(copyValueObjectProps(t, "valueObject()"));
}

/**
 * Compares two value objects for equality based on their values.
 * Uses deep equality comparison that handles:
 * - Nested objects and arrays
 * - Primitives (including NaN)
 * - Dates, Maps, Sets, RegExp
 * - Symbol keys
 * - Circular references
 *
 * @param a - First value object
 * @param b - Second value object
 * @returns true if both objects have the same values, false otherwise
 *
 * @example
 * ```typescript
 * const money1 = valueObject({ amount: 100, currency: "USD" });
 * const money2 = valueObject({ amount: 100, currency: "USD" });
 * valueObjectEquals(money1, money2); // true
 *
 * const address1 = valueObject({
 *   street: "Main St",
 *   coordinates: { lat: 52.5, lng: 13.4 }
 * });
 * const address2 = valueObject({
 *   street: "Main St",
 *   coordinates: { lat: 52.5, lng: 13.4 }
 * });
 * valueObjectEquals(address1, address2); // true
 * ```
 */
export function valueObjectEquals<T>(
	a: ValueObjectOf<T>,
	b: ValueObjectOf<T>,
): boolean {
	return deepEqual(a, b);
}

/** The keys that {@link valueObjectEqualsExcept} leaves out of the comparison. */
export interface ValueObjectEqualsExceptOptions {
	/**
	 * Keys to ignore everywhere in the props. The contents of a `Map`, a
	 * `Set`, and a typed array keep every key.
	 */
	readonly ignoreKeys?: readonly (string | symbol)[];
	/**
	 * Ignores a key at one place. The path leads to the key and does not
	 * include it, for example `["user", "meta", 0, "data"]`.
	 */
	readonly ignoreKeyPredicate?: (
		key: string | symbol,
		path: readonly (string | number | symbol)[],
	) => boolean;
}

/**
 * Compares two value objects for equality while ignoring specified keys.
 * Useful for comparing value objects that contain metadata or optional fields
 * that should not affect equality comparison.
 *
 * The walk enters a nested `ValueObject` instance like any other object,
 * so inside it the path continues with `props`; `ignoreKeys: ["props"]`
 * empties every nested value object. The class of a nested value object
 * counts in every case.
 *
 * @param a - First value object
 * @param b - Second value object
 * @param options - Options specifying which keys to ignore during comparison
 * @returns true if both objects have the same values (after ignoring specified keys), false otherwise
 *
 * @example
 * ```typescript
 * // Value object with metadata
 * const address1 = valueObject({
 *   street: "Main St",
 *   city: "Berlin",
 *   metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-02" }
 * });
 *
 * const address2 = valueObject({
 *   street: "Main St",
 *   city: "Berlin",
 *   metadata: { createdAt: "2024-01-01", updatedAt: "2024-01-03" }
 * });
 *
 * // Compare ignoring metadata timestamps
 * valueObjectEqualsExcept(address1, address2, {
 *   ignoreKeys: ["updatedAt"],
 *   ignoreKeyPredicate: (key, path) => path.includes("metadata")
 * }); // true
 *
 * // Compare ignoring all metadata
 * valueObjectEqualsExcept(address1, address2, {
 *   ignoreKeyPredicate: (key, path) => path.includes("metadata")
 * }); // true
 * ```
 */
export function valueObjectEqualsExcept<T>(
	a: ValueObjectOf<T>,
	b: ValueObjectOf<T>,
	options: ValueObjectEqualsExceptOptions,
): boolean {
	return deepEqualExcept(a, b, options);
}

/**
 * Creates a value object with optional validation.
 * Returns a Result type instead of throwing an error.
 *
 * Note: the Result covers VALIDATION failures only. Non-data values and
 * built-ins without immutable value semantics still throw a
 * `TypeError` from `valueObject()`; they cannot occur in parsed JSON and signal
 * a programming error, not a validation failure.
 *
 * @param t - The data to convert into a value object
 * @param validate - Validation function that returns true if valid
 * @param errorMessage - Optional custom error message if validation fails
 * @returns Result containing the value object if valid, or an error message if validation fails
 *
 * @example
 * ```typescript
 * const result = valueObjectOrError(
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
export function valueObjectOrError<T>(
	t: T,
	validate: (value: T) => boolean,
	errorMessage?: string,
): Result<ValueObjectOf<T>, string> {
	if (!validate(t)) {
		return err(
			errorMessage ?? `Validation failed for value object: ${describeValue(t)}`,
		);
	}
	return ok(valueObject(t));
}

/**
 * Best-effort rendering of a value for the default validation-failure
 * message. `JSON.stringify` throws for cyclic and BigInt-bearing values, and
 * the error path of a Result-returning function must never throw itself.
 */
function describeValue(value: unknown): string {
	try {
		const json = JSON.stringify(value);
		if (json !== undefined) return json;
	} catch {
		// Cyclic or BigInt-bearing values cannot be JSON-serialised.
	}
	return String(value);
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
 * Value Objects are immutable and defined by their properties. A value
 * object can hold other value objects in its props. `equals` compares a
 * nested value object by class and props and does not call its `equals`
 * method.
 *
 * @template T - The shape of the value object's properties
 */
export abstract class ValueObject<T extends object> implements IValueObject<T> {
	public readonly props: Readonly<T>;

	/**
	 * Creates a new ValueObject.
	 * The plain-data properties are deep-cloned and then deeply
	 * frozen, so the caller's own object graph is never frozen or mutated,
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
		rejectValueObjectAsInput(props, "new ValueObject()");
		this.validate(props);
		this.props = deepFreeze(copyValueObjectProps(props, "new ValueObject()"));
		markKitCopy(this);
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
		return new Constructor({ ...this.props, ...(props || {}) } as T);
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
