/**
 * Shared bootstrap for the kit's cross-copy capability registries.
 *
 * A registry is a WeakMap installed once on `globalThis` under a versioned
 * `Symbol.for` key, so aggregates constructed by a bundled plugin copy of
 * the kit cooperate with the host package copy. The key version stamps the
 * capability SHAPE: registrations made under another key stay invisible, so
 * an incompatible copy fails the caller's generic capability check instead
 * of half-working.
 *
 * A registry is not a security boundary against code already running in the
 * same process; it is an architectural boundary kept out of package exports
 * and public aggregate types.
 */
export function createGlobalCapabilityRegistry<TCapability extends object>(
	key: symbol,
): WeakMap<object, TCapability> {
	const existing = Object.getOwnPropertyDescriptor(globalThis, key)?.value;
	if (existing instanceof WeakMap) {
		return existing as WeakMap<object, TCapability>;
	}

	const registry = new WeakMap<object, TCapability>();
	try {
		Object.defineProperty(globalThis, key, {
			value: registry,
			enumerable: false,
			writable: false,
			configurable: false,
		});
	} catch {
		// A hardened host may reject global registration. The local registry
		// still preserves the capability boundary; only duplicate-package
		// cooperation is unavailable in that host.
	}
	return registry;
}
