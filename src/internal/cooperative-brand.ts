/**
 * A cooperative brand marks an object that a kit constructor produced, so
 * a second loaded copy of the kit (duplicate npm dependency, dual CJS/ESM
 * load, plugin bundle) recognizes it. A module-private WeakSet cannot do
 * that: it is bound to one loaded copy. The brand is a `Symbol.for` key
 * with the value `true`. The property is non-enumerable, so it never
 * leaks into spreads, JSON, or equality, and non-writable and
 * non-configurable, so nothing edits it after the stamp.
 *
 * The probe reads the brand as an OWN property with exactly these
 * attributes and requires the carrier to be frozen. An object that
 * inherits a branded object through its prototype can carry mutable own
 * overrides; a branded object that is still open can change after the
 * stamp. Neither is what the constructor produced. Every stamp site
 * therefore freezes the carrier right after {@link stampCooperativeBrand}.
 *
 * The brand is forgeable BY DESIGN. It catches accidental hand-rolled
 * literals; it is not a security boundary against code in the same
 * process that fakes it on purpose.
 *
 * Internal utility (not exported from the package barrels).
 */
export function stampCooperativeBrand(target: object, brand: symbol): void {
	Object.defineProperty(target, brand, {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

/**
 * Whether `value` carries `brand` as an own, non-enumerable, non-writable,
 * non-configurable `true` and is frozen. A Proxy trap that throws reads
 * as unbranded.
 */
export function hasCooperativeBrand(
	value: unknown,
	brand: symbol,
): value is object {
	if (
		value === null ||
		(typeof value !== "object" && typeof value !== "function")
	) {
		return false;
	}
	try {
		const marker = Reflect.getOwnPropertyDescriptor(value, brand);
		return (
			marker?.value === true &&
			marker.enumerable === false &&
			marker.writable === false &&
			marker.configurable === false &&
			Object.isFrozen(value)
		);
	} catch {
		return false;
	}
}
