import type { AggregateSnapshot, Version } from "../aggregate/aggregate";
import type { Id } from "../core/id";
import type { SnapshotStore } from "../repo/snapshot-store";
import { deepEqual } from "../utils/array/deep-equal";
import {
	assert,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
} from "./contract-assertions";

/** One contract test; bind with `(test.skipped ? it.skip : it)(test.name, test.run)`. */
export type SnapshotStoreContractTest = ContractTest;

/** The plain-data state shape the suite round-trips. */
interface SuiteState {
	total: number;
	items: Array<{ sku: string; qty: number }>;
	note?: string;
}

/**
 * One isolated test environment: a fresh snapshot store. The suite
 * creates one per test and tears it down afterwards. No transaction
 * wrapper: the port is transaction-free by design (snapshots are
 * derived data written after the commit; see `SnapshotStore`).
 */
export interface SnapshotStoreContractEnvironment {
	/** The adapter under test. */
	store: SnapshotStore<SuiteState>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/**
 * What an adapter supplies to run the snapshot-store contract suite.
 * For SQL adapters, run against a real database (testcontainers or
 * equivalent). Note the fidelity demands the suite enforces:
 * `snapshotAt` must survive with millisecond precision (store it as
 * ISO-8601 text or epoch milliseconds; MySQL `DATETIME` without
 * fractional seconds truncates), and an ABSENT `schemaVersion` must
 * come back absent, not as `0` or `null`-coerced.
 */
export interface SnapshotStoreContractHarness {
	createEnvironment(): Promise<SnapshotStoreContractEnvironment>;
}

const AT = new Date("2026-01-05T10:20:30.456Z");

function snapshot(
	version: number,
	state: SuiteState,
	schemaVersion?: number,
): AggregateSnapshot<SuiteState> {
	return {
		state,
		version: version as Version,
		// A fresh Date per snapshot: an adapter that normalizes the input
		// Date IN PLACE must not be able to mutate the suite's expected
		// value into agreeing with it.
		snapshotAt: new Date(AT),
		...(schemaVersion === undefined ? {} : { schemaVersion }),
	};
}

const id = (value: string): Id<string> => value as Id<string>;

/**
 * The snapshot-store contract test suite: the proof that an adapter
 * delivers the round-trip and isolation semantics the
 * snapshot-plus-recent-events load path relies on. Store semantics are
 * an **adapter contract, not a kit guarantee**; this suite is how an
 * adapter demonstrates them.
 *
 * Framework-agnostic: bind with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export function createSnapshotStoreContractTests(
	harness: SnapshotStoreContractHarness,
): SnapshotStoreContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());

	return [
		{
			name: "an aggregate without a snapshot loads undefined",
			run: inEnv(async (env) => {
				assertEqual(
					await env.store.load("Order", id("o-1")),
					undefined,
					"a fresh store must report no snapshot; the repository falls back to full replay",
				);
			}),
		},
		{
			name: "save/load round-trips state, version, snapshotAt (millisecond fidelity), and schemaVersion",
			run: inEnv(async (env) => {
				const stored = snapshot(
					42,
					{ total: 7, items: [{ sku: "a", qty: 2 }], note: "hi" },
					3,
				);
				await env.store.save("Order", id("o-1"), stored);
				const loaded = await env.store.load("Order", id("o-1"));
				assert(loaded !== undefined, "the saved snapshot must load");
				assert(
					deepEqual(loaded.state, stored.state),
					"the state must round-trip deep-equal as plain data",
				);
				assertEqual(
					loaded.version,
					42,
					"the aggregate version must round-trip",
				);
				assert(
					loaded.snapshotAt instanceof Date,
					"snapshotAt must round-trip as a Date; rehydrate your storage format (ISO-8601 text, epoch ms) on load",
				);
				assertEqual(
					loaded.snapshotAt.getTime(),
					AT.getTime(),
					"snapshotAt must survive with millisecond precision (store ISO-8601 text or epoch ms)",
				);
				assertEqual(
					loaded.schemaVersion,
					3,
					"schemaVersion must round-trip verbatim; the restore path compares it against the aggregate's declared schema",
				);
			}),
		},
		{
			name: "an absent schemaVersion round-trips as absent",
			run: inEnv(async (env) => {
				await env.store.save(
					"Order",
					id("o-1"),
					snapshot(1, { total: 0, items: [] }),
				);
				const loaded = await env.store.load("Order", id("o-1"));
				assertEqual(
					loaded?.schemaVersion,
					undefined,
					"a snapshot stored without schemaVersion must not come back with a fabricated one; restore treats absence as schema 1",
				);
			}),
		},
		{
			name: "save replaces the previous snapshot: latest wins, no history",
			run: inEnv(async (env) => {
				await env.store.save(
					"Order",
					id("o-1"),
					snapshot(10, { total: 1, items: [] }),
				);
				await env.store.save(
					"Order",
					id("o-1"),
					snapshot(20, { total: 2, items: [] }),
				);
				const loaded = await env.store.load("Order", id("o-1"));
				assert(
					loaded?.version === 20 && loaded.state.total === 2,
					"load must return the latest snapshot only",
				);
			}),
		},
		{
			name: "snapshots are isolated per aggregate type AND per aggregate id",
			run: inEnv(async (env) => {
				await env.store.save(
					"Order",
					id("x-1"),
					snapshot(1, { total: 1, items: [] }),
				);
				await env.store.save(
					"Invoice",
					id("x-1"),
					snapshot(2, { total: 2, items: [] }),
				);
				await env.store.save(
					"Order",
					id("x-2"),
					snapshot(3, { total: 3, items: [] }),
				);
				const [orderX1, invoiceX1, orderX2] = await Promise.all([
					env.store.load("Order", id("x-1")),
					env.store.load("Invoice", id("x-1")),
					env.store.load("Order", id("x-2")),
				]);
				assert(
					orderX1?.version === 1 &&
						invoiceX1?.version === 2 &&
						orderX2?.version === 3,
					"the key is the (aggregateType, aggregateId) pair; neither half may bleed into the other",
				);
			}),
		},
		{
			name: "delete removes exactly the addressed snapshot and tolerates unknown keys",
			run: inEnv(async (env) => {
				await env.store.save(
					"Order",
					id("o-1"),
					snapshot(1, { total: 1, items: [] }),
				);
				await env.store.save(
					"Order",
					id("o-2"),
					snapshot(2, { total: 2, items: [] }),
				);
				await env.store.delete("Order", id("o-1"));
				await env.store.delete("Order", id("never-saved"));
				assertEqual(
					await env.store.load("Order", id("o-1")),
					undefined,
					"the deleted snapshot must be gone (schema-migration fallback and erasure both rely on it)",
				);
				assertEqual(
					(await env.store.load("Order", id("o-2")))?.version,
					2,
					"a sibling snapshot must survive the delete",
				);
			}),
		},
		{
			name: "loads are detached copies and saves capture the input: later mutations touch nothing",
			run: inEnv(async (env) => {
				const input = snapshot(5, { total: 5, items: [{ sku: "a", qty: 1 }] });
				await env.store.save("Order", id("o-1"), input);
				// Mutating the caller's input AFTER save must not reach the store.
				input.state.items.push({ sku: "hacked", qty: 99 });

				const loaded = await env.store.load("Order", id("o-1"));
				assert(loaded !== undefined, "expected the saved snapshot");
				assertEqual(
					loaded.state.items.length,
					1,
					"save must capture the snapshot by value, not hold the caller's reference",
				);
				// Mutating the loaded copy must not corrupt the stored one.
				loaded.state.total = 999;
				const reloaded = await env.store.load("Order", id("o-1"));
				assertEqual(
					reloaded?.state.total,
					5,
					"load must hand out a detached copy, never live internal state",
				);
			}),
		},
	];
}
