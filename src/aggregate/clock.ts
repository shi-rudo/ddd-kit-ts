/**
 * Module-internal home of the kit's swappable clock. The public surface
 * (`ClockFactory`, `setClockFactory`, `withClockFactory`,
 * `resetClockFactory`) is re-exported through `domain-event.ts`; the
 * `now()` accessor stays internal so the barrel files never ship it.
 * Living in its own module lets `createDomainEvent` (occurredAt) and
 * `BaseAggregate.createSnapshot` (snapshotAt) read the same clock
 * without an import cycle between those files.
 */

/**
 * Clock function producing a fresh `Date` for each call. The library
 * defaults to `() => new Date()`; override globally via `setClockFactory`
 * for deterministic event-sourcing tests, time-travel debugging, or any
 * scenario where `occurredAt` / `snapshotAt` must be reproducible.
 */
export type ClockFactory = () => Date;

const defaultClockFactory: ClockFactory = () => new Date();
let currentClockFactory: ClockFactory = defaultClockFactory;

/**
 * Internal: the current clock reading. Consumers of the kit control it
 * via `setClockFactory` / `withClockFactory`; kit code that needs a
 * timestamp (event `occurredAt`, snapshot `snapshotAt`) reads through
 * this accessor instead of a hard `new Date()`, so a swapped clock
 * covers every timestamp the kit stamps.
 */
export function now(): Date {
	// Defensive copy at the single source: a factory returning a SHARED
	// Date (the withClockFactory(() => fixed, ...) pattern above) must
	// not be frozen by event creation nor aliased into snapshots.
	return new Date(currentClockFactory().getTime());
}

/**
 * Replaces the global clock factory used by `createDomainEvent` and
 * `createSnapshot`. Call once during application bootstrap (or per-test
 * in deterministic test suites):
 *
 * ```ts
 * import { setClockFactory } from "@shirudo/ddd-kit";
 *
 * setClockFactory(() => new Date("2026-01-01T00:00:00Z"));
 * ```
 *
 * The per-call `options.occurredAt` override always wins over this
 * factory. Symmetric to `setEventIdFactory`.
 *
 * Module-scoped: see `setEventIdFactory` for the global-state
 * caveats. For test isolation prefer {@link withClockFactory}; for
 * multi-tenant request isolation prefer the per-call
 * `options.occurredAt`.
 */
export function setClockFactory(factory: ClockFactory): void {
	currentClockFactory = factory;
}

/**
 * Scoped variant of {@link setClockFactory}: installs `factory`, runs
 * `fn`, then restores the previous factory in a `finally` block.
 * Synchronous-only, with the same constraints (and same runtime thenable
 * guard) as `withEventIdFactory`.
 *
 * **When to prefer the per-call `options.occurredAt` instead.** Same
 * trade-off as `withEventIdFactory`: passing `{ occurredAt }`
 * to `createDomainEvent` is the strongest isolation for single-event
 * cases. The scoped helper is for events constructed deep inside
 * domain methods where threading an explicit timestamp is awkward.
 *
 * @example
 * ```ts
 * it("stamps events with a fixed clock", () => {
 *   const fixed = new Date("2026-01-01T00:00:00Z");
 *   withClockFactory(() => fixed, () => {
 *     const e = createDomainEvent("X", { v: 1 });
 *     expect(e.occurredAt).toEqual(fixed);
 *   });
 * });
 * ```
 */
export function withClockFactory<T>(factory: ClockFactory, fn: () => T): T {
	const previous = currentClockFactory;
	currentClockFactory = factory;
	try {
		const result = fn();
		assertNotThenable(result, "withClockFactory");
		return result;
	} finally {
		currentClockFactory = previous;
	}
}

/**
 * Restores the default clock factory (`() => new Date()`).
 * Intended for use in test `afterEach` hooks.
 */
export function resetClockFactory(): void {
	currentClockFactory = defaultClockFactory;
}

/**
 * Internal guard for the scoped factory helpers (`withClockFactory`,
 * `withEventIdFactory`). Throws a clear error when the user-supplied
 * `fn` returns a thenable: the helpers are synchronous-only, and a
 * silent async-misuse would restore the factory before the awaited body
 * of `fn` runs, leaving the awaited code reading the previous factory.
 */
export function assertNotThenable(result: unknown, helperName: string): void {
	if (
		result !== null &&
		(typeof result === "object" || typeof result === "function") &&
		typeof (result as { then?: unknown }).then === "function"
	) {
		throw new Error(
			`${helperName}: fn returned a thenable. ` +
				`The factory is only installed for the synchronous portion of fn; ` +
				`awaited continuations would see the previous factory. ` +
				`For async-scoped factories use AsyncLocalStorage.`,
		);
	}
}
