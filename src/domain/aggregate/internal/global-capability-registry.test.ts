import { describe, expect, it } from "vite-plus/test";
import {
	CapabilityRegistryConflictError,
	UnmanagedInstanceError,
} from "../../../errors/kit-errors";
import { createGlobalCapabilityRegistry } from "./global-capability-registry";

type Capability = { readonly name: string };

describe("createGlobalCapabilityRegistry", () => {
	it("installs one shared registry per key and hands the same map to a second bootstrap", () => {
		const host = {};
		const key = Symbol.for("@shirudo/ddd-kit/test-registry/shared");

		const first = createGlobalCapabilityRegistry<Capability>(key, host);
		const second = createGlobalCapabilityRegistry<Capability>(key, host);

		expect(first.shared).toBe(true);
		expect(second.shared).toBe(true);
		expect(second.registry).toBe(first.registry);
		expect(Object.getOwnPropertyDescriptor(host, key)).toMatchObject({
			enumerable: false,
			writable: false,
			configurable: false,
		});
	});

	it("resolves a registered capability and rejects an unknown or nullish instance with one coded error", () => {
		const host = {};
		const key = Symbol.for("@shirudo/ddd-kit/test-registry/require");
		const { registry, require } = createGlobalCapabilityRegistry<Capability>(
			key,
			host,
		);
		const known = { id: "known-1" };
		registry.set(known, { name: "known" });

		expect(require(known, "operate", "aggregate").name).toBe("known");
		for (const instance of [{ id: "unknown-1" }, null, undefined]) {
			let caught: unknown;
			try {
				require(instance as unknown as object, "operate", "aggregate");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(UnmanagedInstanceError);
			expect((caught as UnmanagedInstanceError).code).toBe(
				"UNMANAGED_INSTANCE",
			);
		}
	});

	it("names the private registry in the rejection when the host refused the registration", () => {
		const host = Object.preventExtensions({});
		const key = Symbol.for("@shirudo/ddd-kit/test-registry/require-private");
		const { require } = createGlobalCapabilityRegistry<Capability>(key, host);

		let caught: unknown;
		try {
			require({ id: "x" }, "operate", "aggregate");
		} catch (error) {
			caught = error;
		}

		expect((caught as UnmanagedInstanceError).message).toContain("private");
	});

	it("refuses a key that an accessor holds, even one that yields a WeakMap", () => {
		const host = {};
		const key = Symbol.for("@shirudo/ddd-kit/test-registry/accessor");
		Object.defineProperty(host, key, {
			get: () => new WeakMap(),
			configurable: true,
		});

		expect(() => createGlobalCapabilityRegistry<Capability>(key, host)).toThrow(
			CapabilityRegistryConflictError,
		);
	});

	it("refuses a key that another module already holds with a foreign value", () => {
		const host = {};
		const key = Symbol.for("@shirudo/ddd-kit/test-registry/conflict");
		Object.defineProperty(host, key, { value: 42, configurable: true });

		expect(() => createGlobalCapabilityRegistry<Capability>(key, host)).toThrow(
			CapabilityRegistryConflictError,
		);
		expect(Object.getOwnPropertyDescriptor(host, key)?.value).toBe(42);
	});

	it("falls back to a private registry when the host rejects the global registration", () => {
		const host = Object.preventExtensions({});
		const key = Symbol.for("@shirudo/ddd-kit/test-registry/hardened");

		const { registry, shared } = createGlobalCapabilityRegistry<Capability>(
			key,
			host,
		);
		const instance = {};
		registry.set(instance, { name: "local" });

		expect(shared).toBe(false);
		expect(registry.get(instance)?.name).toBe("local");
		expect(Object.getOwnPropertyDescriptor(host, key)).toBeUndefined();
	});
});
