import {
	CapabilityRegistryConflictError,
	UnmanagedInstanceError,
} from "../../../errors/kit-errors";

/**
 * A capability registry with the outcome of its bootstrap and the one
 * lookup-or-reject every capability module uses.
 */
export interface CapabilityRegistry<TCapability extends object> {
	readonly registry: WeakMap<object, TCapability>;
	/**
	 * `false` when the host rejected the global registration. The registry
	 * then belongs to this package copy alone, and an instance constructed by
	 * another copy cannot be recognized.
	 */
	readonly shared: boolean;
	/**
	 * Resolves the capability of `instance` or throws
	 * {@link UnmanagedInstanceError} naming the operation, the subject, and
	 * the instance id. When the registry is private to this package copy,
	 * the error says so, because that is the one reason an instance from
	 * another copy cannot be recognized. A nullish instance is rejected the
	 * same way.
	 */
	require(instance: object, operation: string, subject: string): TCapability;
}

/**
 * The sentence a capability lookup appends to its rejection when the
 * registry is private to this copy, so the reader learns why an instance
 * from another package copy was not recognized.
 */
const LOCAL_REGISTRY_DETAIL =
	"The capability registry of this package copy is private because the " +
	"host rejected the global registration, so an instance from another " +
	"package copy cannot be recognized.";

const weakMapHas = WeakMap.prototype.has;
const PROBE_KEY = {};

/**
 * `instanceof WeakMap` binds to the constructor of this realm. A registry
 * that a kit copy installed from another realm (a `vm` context, an iframe)
 * would then read as a foreign value and raise a false conflict. The
 * internal-slot probe gives the same answer in every realm, and a plain
 * object cannot spoof it through `Symbol.toStringTag`.
 */
function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
	try {
		weakMapHas.call(value, PROBE_KEY);
		return true;
	} catch {
		return false;
	}
}

/**
 * Shared bootstrap for the kit's cross-copy capability registries.
 *
 * A registry is a WeakMap installed once on the host (`globalThis`) under a
 * versioned `Symbol.for` key, so aggregates constructed by a bundled plugin
 * copy of the kit cooperate with the host package copy. The key version
 * stamps the capability SHAPE: registrations made under another key stay
 * invisible, so an incompatible copy fails the caller's capability check
 * instead of half-working.
 *
 * Two bootstrap failures are loud in different ways. A key that already
 * holds a value which is not a registry belongs to another module; the kit
 * throws {@link CapabilityRegistryConflictError} instead of overwriting it.
 * A host that rejects the registration (a non-extensible `globalThis`)
 * leaves the registry private to this copy, reported through `shared`.
 *
 * A registry is not a security boundary against code already running in the
 * same process; it is an architectural boundary kept out of package exports
 * and public aggregate types.
 */
export function createGlobalCapabilityRegistry<TCapability extends object>(
	key: symbol,
	host: object = globalThis,
): CapabilityRegistry<TCapability> {
	const descriptor = Object.getOwnPropertyDescriptor(host, key);
	if (descriptor !== undefined) {
		if (isWeakMap(descriptor.value)) {
			return withRequire(
				descriptor.value as WeakMap<object, TCapability>,
				true,
			);
		}
		throw new CapabilityRegistryConflictError(key);
	}

	const registry = new WeakMap<object, TCapability>();
	try {
		Object.defineProperty(host, key, {
			value: registry,
			enumerable: false,
			writable: false,
			configurable: false,
		});
		return withRequire(registry, true);
	} catch {
		return withRequire(registry, false);
	}
}

function withRequire<TCapability extends object>(
	registry: WeakMap<object, TCapability>,
	shared: boolean,
): CapabilityRegistry<TCapability> {
	return {
		registry,
		shared,
		require: (instance, operation, subject) => {
			const capability =
				instance === null || instance === undefined
					? undefined
					: registry.get(instance);
			if (capability !== undefined) return capability;
			throw new UnmanagedInstanceError(
				operation,
				subject,
				(instance as { id?: unknown } | null | undefined)?.id,
				shared ? undefined : LOCAL_REGISTRY_DETAIL,
			);
		},
	};
}
