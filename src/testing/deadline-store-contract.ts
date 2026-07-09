import type { DeadlineStore } from "../deadlines/deadline-store";
import { deepEqual } from "../utils/array/deep-equal";
import {
	assert,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
	gatedContractTest,
} from "./contract-assertions";

/** One contract test; bind with `(test.skipped ? it.skip : it)(test.name, test.run)`. */
export type DeadlineStoreContractTest = ContractTest;

/** The plain-data payload shape the suite round-trips. */
interface SuitePayload {
	kind: string;
	step?: number;
}

/**
 * One isolated test environment: a fresh deadline store. The suite
 * creates one per test and tears it down afterwards.
 */
export interface DeadlineStoreContractEnvironment {
	/** The adapter under test. */
	store: DeadlineStore<SuitePayload>;

	/**
	 * Runs `work` (schedule/cancel calls) the way production does:
	 * inside a transaction that COMMITS. For a non-transactional store
	 * this simply invokes `work`.
	 */
	run<R>(work: () => Promise<R>): Promise<R>;

	/**
	 * Optional capability: runs `work` inside a transaction that ROLLS
	 * BACK. Enables the rollback tests: a rolled-back schedule must not
	 * leave a deadline behind (a ghost input for a state change that
	 * never happened), and a rolled-back cancel must not have removed
	 * one. Transactional adapters should always provide this.
	 */
	runRolledBack?<R>(work: () => Promise<R>): Promise<R>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/**
 * What an adapter supplies to run the deadline-store contract suite.
 * For SQL adapters, run against a real database (testcontainers or
 * equivalent): the rollback tests prove YOUR transaction wiring, and
 * schedule/cancel joining the write transaction is the port's central
 * correctness rule.
 */
export interface DeadlineStoreContractHarness {
	createEnvironment(): Promise<DeadlineStoreContractEnvironment>;

	/**
	 * The adapter's attempt ceiling: how many `markFailed` reports move
	 * a deadline to the dead-letter set. Must be at least 2 so the
	 * attempts-surfacing test can observe a survivor.
	 */
	failuresToDeadLetter: number;

	/**
	 * Declare `true` when environments provide {@link
	 * DeadlineStoreContractEnvironment.runRolledBack}. Without it, the
	 * rollback tests are marked skipped: the honest state of an
	 * in-memory fake, and a loud gap for a transactional adapter.
	 */
	providesRolledBackRuns?: boolean;

	/**
	 * Declare `true` when the adapter's `due` CLAIMS the returned
	 * records for competing pollers (lease, visibility timeout), as the
	 * port sanctions. Tests that re-poll records an earlier poll
	 * returned without resolving them (attempts surfacing, neighbor
	 * flow after a dead-letter, successor visibility during a
	 * reschedule race) assume a non-claiming read and are marked
	 * skipped for claiming adapters; prove your claim/expiry semantics
	 * in your own suite.
	 */
	claimsOnDue?: boolean;
}

const at = (iso: string): Date => new Date(iso);
const T0 = "2026-03-01T10:00:00.000Z";
const T1 = "2026-03-01T10:05:00.000Z";
const T2 = "2026-03-01T10:10:00.000Z";

/**
 * The deadline-store contract test suite: the proof that an adapter
 * delivers the schedule/cancel/due/acknowledge semantics the port
 * documents. Store semantics are an **adapter contract, not a kit
 * guarantee**; this suite is how an adapter demonstrates them.
 *
 * Framework-agnostic: bind with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export function createDeadlineStoreContractTests(
	harness: DeadlineStoreContractHarness,
): DeadlineStoreContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());
	const ceiling = harness.failuresToDeadLetter;
	if (!Number.isInteger(ceiling) || ceiling < 2) {
		throw new Error(
			"Contract violated: failuresToDeadLetter must be an integer >= 2; observing attempts on a pending deadline needs one that survives a failure",
		);
	}

	return [
		{
			name: "a deadline is invisible before its due time and delivered from it onward",
			run: inEnv(async (env) => {
				await env.run(() =>
					env.store.schedule({
						scope: "checkout-saga",
						key: "order-1",
						dueAt: at(T1),
						payload: { kind: "payment-timeout" },
					}),
				);
				assertEqual(
					(await env.store.due(at(T0), 10)).length,
					0,
					"a deadline must not fire early",
				);
				const dueExactly = await env.store.due(at(T1), 10);
				assertEqual(
					dueExactly.length,
					1,
					"a deadline is due AT its due time (dueAt <= now)",
				);
				const record = dueExactly[0];
				assert(record !== undefined, "expected the due deadline");
				assertEqual(record.scope, "checkout-saga", "scope must round-trip");
				assertEqual(record.key, "order-1", "key must round-trip");
				assertEqual(
					record.dueAt.getTime(),
					at(T1).getTime(),
					"dueAt must round-trip with millisecond fidelity",
				);
				assert(
					deepEqual(record.payload, { kind: "payment-timeout" }),
					"the payload must round-trip as plain data",
				);
				assertEqual(record.attempts, 0, "a fresh deadline has no attempts");
			}),
		},
		{
			name: "due returns earliest first and respects the limit",
			run: inEnv(async (env) => {
				await env.run(async () => {
					await env.store.schedule({
						scope: "s",
						key: "late",
						dueAt: at(T2),
						payload: { kind: "late" },
					});
					await env.store.schedule({
						scope: "s",
						key: "early",
						dueAt: at(T0),
						payload: { kind: "early" },
					});
					await env.store.schedule({
						scope: "s",
						key: "middle",
						dueAt: at(T1),
						payload: { kind: "middle" },
					});
				});
				const firstPage = await env.store.due(at(T2), 2);
				assert(
					firstPage.length >= 1 && firstPage.length <= 2,
					"limit must bound the page: up to limit records, at least one while deadlines are due",
				);
				assertEqual(
					firstPage[0]?.key,
					"early",
					"the earliest due deadline comes first",
				);
			}),
		},
		{
			name: "markDelivered consumes the deadline and is idempotent on unknown and repeated ids",
			run: inEnv(async (env) => {
				await env.run(() =>
					env.store.schedule({
						scope: "s",
						key: "k",
						dueAt: at(T0),
						payload: { kind: "x" },
					}),
				);
				const [record] = await env.store.due(at(T1), 10);
				assert(record !== undefined, "expected a due deadline");
				await env.store.markDelivered([record.deliveryId]);
				await env.store.markDelivered([record.deliveryId]);
				await env.store.markDelivered(["no-such-delivery-id"]);
				assert(
					!(await env.store.due(at(T2), 10)).some(
						(d) => d.deliveryId === record.deliveryId,
					),
					"a delivered deadline must never come back",
				);
			}),
		},
		{
			name: "cancel removes exactly the addressed deadline and tolerates unknown addresses",
			run: inEnv(async (env) => {
				await env.run(async () => {
					await env.store.schedule({
						scope: "s",
						key: "keep",
						dueAt: at(T0),
						payload: { kind: "keep" },
					});
					await env.store.schedule({
						scope: "s",
						key: "drop",
						dueAt: at(T0),
						payload: { kind: "drop" },
					});
					await env.store.cancel("s", "drop");
					await env.store.cancel("s", "never-scheduled");
				});
				const due = await env.store.due(at(T1), 10);
				assert(
					deepEqual(
						due.map((d) => d.key),
						["keep"],
					),
					"cancel must remove the addressed deadline and nothing else",
				);
			}),
		},
		{
			name: "addresses are isolated per scope",
			run: inEnv(async (env) => {
				await env.run(async () => {
					await env.store.schedule({
						scope: "reservation-hold",
						key: "id-1",
						dueAt: at(T0),
						payload: { kind: "hold" },
					});
					await env.store.schedule({
						scope: "checkout-saga",
						key: "id-1",
						dueAt: at(T0),
						payload: { kind: "timeout" },
					});
					await env.store.cancel("reservation-hold", "id-1");
				});
				const due = await env.store.due(at(T1), 10);
				assert(
					due.length === 1 && due[0]?.scope === "checkout-saga",
					"the same key under another scope is a different deadline",
				);
			}),
		},
		// The successor-visibility half of the race needs a re-poll while the
		// replaced incarnation is un-acked; an adapter claiming at address
		// granularity legitimately holds the address until the claim resolves.
		gatedContractTest(
			{ capability: "non-claiming due", satisfiedBy: !harness.claimsOnDue },
			{
				name: "schedule on an occupied address replaces it, and a stale ack cannot consume the successor",
				run: inEnv(async (env) => {
					await env.run(() =>
						env.store.schedule({
							scope: "s",
							key: "k",
							dueAt: at(T0),
							payload: { kind: "first", step: 1 },
						}),
					);
					const [first] = await env.store.due(at(T1), 10);
					assert(first !== undefined, "expected the first incarnation");

					// Reschedule while the first incarnation is in flight.
					await env.run(() =>
						env.store.schedule({
							scope: "s",
							key: "k",
							dueAt: at(T1),
							payload: { kind: "second", step: 2 },
						}),
					);
					// The late ack of the replaced incarnation must be a no-op.
					await env.store.markDelivered([first.deliveryId]);

					const due = await env.store.due(at(T2), 10);
					assertEqual(
						due.length,
						1,
						"exactly one pending deadline exists per address",
					);
					const successor = due[0];
					assert(successor !== undefined, "expected the successor");
					assert(
						deepEqual(successor.payload, { kind: "second", step: 2 }),
						"the successor carries the rescheduled payload",
					);
					assert(
						successor.deliveryId !== first.deliveryId,
						"a reschedule is a fresh incarnation with a fresh deliveryId",
					);
				}),
			},
		),
		{
			name: "after delivery the address is free again for a fresh schedule",
			run: inEnv(async (env) => {
				await env.run(() =>
					env.store.schedule({
						scope: "s",
						key: "k",
						dueAt: at(T0),
						payload: { kind: "first" },
					}),
				);
				const [first] = await env.store.due(at(T1), 10);
				assert(first !== undefined, "expected a due deadline");
				await env.store.markDelivered([first.deliveryId]);
				await env.run(() =>
					env.store.schedule({
						scope: "s",
						key: "k",
						dueAt: at(T1),
						payload: { kind: "again" },
					}),
				);
				const due = await env.store.due(at(T2), 10);
				assert(
					due.length === 1 && deepEqual(due[0]?.payload, { kind: "again" }),
					"a consumed address must accept a new deadline",
				);
			}),
		},
		{
			name: "the attempt ceiling dead-letters the deadline, visible in deadLetters with its attempt count",
			run: inEnv(async (env) => {
				await env.run(() =>
					env.store.schedule({
						scope: "s",
						key: "poison",
						dueAt: at(T0),
						payload: { kind: "poison" },
					}),
				);
				const [poison] = await env.store.due(at(T1), 1);
				assert(poison !== undefined, "expected the due deadline");
				for (let i = 0; i < ceiling; i++) {
					await env.store.markFailed(poison.deliveryId, new Error("boom"));
				}
				// Membership, not count: dead-lettered is terminal for every
				// adapter, claiming or not.
				assert(
					!(await env.store.due(at(T2), 10)).some(
						(d) => d.deliveryId === poison.deliveryId,
					),
					"a dead-lettered deadline must stop coming back",
				);
				const dead = await env.store.deadLetters();
				assert(
					dead.length === 1 && dead[0]?.attempts === ceiling,
					"the dead-lettered deadline must appear in deadLetters() with its attempt count",
				);
			}),
		},
		// Observing attempts on a pending record, and a neighbor's continued
		// flow, both need re-polls of records an earlier poll returned
		// without resolving them; claiming adapters legitimately hold those
		// back until the claim expires.
		gatedContractTest(
			{ capability: "non-claiming due", satisfiedBy: !harness.claimsOnDue },
			{
				name: "attempts surface on redelivery, and a poison deadline does not block its neighbors",
				run: inEnv(async (env) => {
					await env.run(async () => {
						await env.store.schedule({
							scope: "s",
							key: "poison",
							dueAt: at(T0),
							payload: { kind: "poison" },
						});
						await env.store.schedule({
							scope: "s",
							key: "healthy",
							dueAt: at(T0),
							payload: { kind: "healthy" },
						});
					});
					const [poison] = await env.store.due(at(T1), 1);
					assert(poison !== undefined, "expected the earliest due deadline");
					await env.store.markFailed(poison.deliveryId, new Error("boom"));
					const afterOne = await env.store.due(at(T1), 10);
					assertEqual(
						afterOne.find((d) => d.deliveryId === poison.deliveryId)?.attempts,
						1,
						"attempts must be surfaced on the record after markFailed",
					);
					for (let i = 1; i < ceiling; i++) {
						await env.store.markFailed(poison.deliveryId, new Error("boom"));
					}
					assert(
						(await env.store.due(at(T1), 10)).some((d) => d.key === "healthy"),
						"deadlines carry no cross-address ordering; a dead-lettered neighbor must not block delivery",
					);
				}),
			},
		),
		{
			name: "two dead-lettered incarnations of one address are both kept and individually clearable",
			run: inEnv(async (env) => {
				await env.run(() =>
					env.store.schedule({
						scope: "s",
						key: "k",
						dueAt: at(T0),
						payload: { kind: "first" },
					}),
				);
				const [first] = await env.store.due(at(T1), 10);
				assert(first !== undefined, "expected the first incarnation");
				for (let i = 0; i < ceiling; i++) {
					await env.store.markFailed(first.deliveryId, new Error("boom"));
				}
				// The dead letter freed the address; the process schedules a
				// fresh incarnation, and it dead-letters too.
				await env.run(() =>
					env.store.schedule({
						scope: "s",
						key: "k",
						dueAt: at(T1),
						payload: { kind: "second" },
					}),
				);
				const [second] = await env.store.due(at(T2), 10);
				assert(second !== undefined, "expected the second incarnation");
				for (let i = 0; i < ceiling; i++) {
					await env.store.markFailed(second.deliveryId, new Error("boom"));
				}
				const dead = await env.store.deadLetters();
				assert(
					dead.length === 2 &&
						dead.some((d) => d.deliveryId === first.deliveryId) &&
						dead.some((d) => d.deliveryId === second.deliveryId),
					"dead letters are kept per incarnation; a later dead letter of the same address must not overwrite an earlier un-acked one",
				);
				await env.store.markDelivered([first.deliveryId]);
				const remaining = await env.store.deadLetters();
				assert(
					remaining.length === 1 &&
						remaining[0]?.deliveryId === second.deliveryId,
					"acknowledging one dead-lettered incarnation must not clear its sibling",
				);
			}),
		},
		{
			name: "late failure reports never resurrect or advance anything, and acking a dead letter clears it",
			run: inEnv(async (env) => {
				await env.run(() =>
					env.store.schedule({
						scope: "s",
						key: "k",
						dueAt: at(T0),
						payload: { kind: "x" },
					}),
				);
				const [record] = await env.store.due(at(T1), 10);
				assert(record !== undefined, "expected a due deadline");
				for (let i = 0; i < ceiling; i++) {
					await env.store.markFailed(record.deliveryId, new Error("boom"));
				}
				// Late reports against a dead-lettered incarnation: no-ops.
				await env.store.markFailed(record.deliveryId, new Error("late"));
				await env.store.markFailed("no-such-id", new Error("unknown"));
				assertEqual(
					(await env.store.deadLetters()).length,
					1,
					"late or unknown failure reports must not change the dead-letter set",
				);
				// Manual redelivery, then ack: the dead letter clears.
				await env.store.markDelivered([record.deliveryId]);
				assertEqual(
					(await env.store.deadLetters()).length,
					0,
					"acking a dead-lettered deadline must clear it",
				);
			}),
		},
		gatedContractTest(
			{
				capability: "providesRolledBackRuns",
				satisfiedBy: harness.providesRolledBackRuns === true,
			},
			{
				name: "a rolled-back schedule leaves no deadline behind",
				run: inEnv(async (env) => {
					if (!env.runRolledBack) {
						throw new Error(
							"Contract violated: harness declared providesRolledBackRuns but the environment lacks runRolledBack",
						);
					}
					await env
						.runRolledBack(() =>
							env.store.schedule({
								scope: "s",
								key: "ghost",
								dueAt: at(T0),
								payload: { kind: "ghost" },
							}),
						)
						.catch(() => {
							// The rollback mechanism may surface as a rejection; the
							// contract under test is the store state afterwards.
						});
					assertEqual(
						(await env.store.due(at(T2), 10)).length,
						0,
						"a deadline from a rolled-back transaction is a ghost input and must not exist",
					);
				}),
			},
		),
		gatedContractTest(
			{
				capability: "providesRolledBackRuns",
				satisfiedBy: harness.providesRolledBackRuns === true,
			},
			{
				name: "a rolled-back cancel leaves the deadline in place",
				run: inEnv(async (env) => {
					if (!env.runRolledBack) {
						throw new Error(
							"Contract violated: harness declared providesRolledBackRuns but the environment lacks runRolledBack",
						);
					}
					await env.run(() =>
						env.store.schedule({
							scope: "s",
							key: "k",
							dueAt: at(T0),
							payload: { kind: "x" },
						}),
					);
					await env
						.runRolledBack(() => env.store.cancel("s", "k"))
						.catch(() => {
							// See above: only the state afterwards is the contract.
						});
					assertEqual(
						(await env.store.due(at(T1), 10)).length,
						1,
						"a cancel from a rolled-back transaction must not have removed the deadline",
					);
				}),
			},
		),
	];
}
