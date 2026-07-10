import type {
	AggregateAddress,
	ProjectionCheckpointStore,
	ProjectionPosition,
} from "../projections/ports";
import {
	assert,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
	gatedContractTest,
} from "./contract-assertions";

/** One contract test; bind with `(test.skipped ? it.skip : it)(test.name, test.run)`. */
export type ProjectionCheckpointStoreContractTest = ContractTest;

/**
 * One isolated test environment: a fresh checkpoint store. The suite
 * creates one per test and tears it down afterwards.
 */
export interface ProjectionCheckpointStoreContractEnvironment<TCtx> {
	/** The adapter under test. */
	store: ProjectionCheckpointStore<TCtx>;

	/**
	 * Runs `work` inside a transaction that COMMITS, handing it the
	 * transaction context the store methods expect, the way the
	 * `Projector` calls them in production. For a non-transactional
	 * store this simply invokes `work` with a dummy context.
	 */
	run<R>(work: (ctx: TCtx) => Promise<R>): Promise<R>;

	/**
	 * Optional capability: runs `work` inside a transaction that ROLLS
	 * BACK. Enables the rollback test: a rolled-back save must leave no
	 * checkpoint behind, the half of the atomic update+checkpoint
	 * promise the store contributes. Transactional adapters should
	 * always provide this; in-memory fakes cannot.
	 */
	runRolledBack?<R>(work: (ctx: TCtx) => Promise<R>): Promise<R>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/**
 * What an adapter supplies to run the projection-checkpoint-store
 * contract suite. For SQL adapters, run against a real database
 * (testcontainers or equivalent): the rollback test proves YOUR
 * transaction wiring, and the checkpoint table must live in the same
 * database as the read models it accounts for.
 */
export interface ProjectionCheckpointStoreContractHarness<TCtx> {
	createEnvironment(): Promise<
		ProjectionCheckpointStoreContractEnvironment<TCtx>
	>;

	/**
	 * Declare `true` when environments provide {@link
	 * ProjectionCheckpointStoreContractEnvironment.runRolledBack}.
	 * Without it, the rollback test is marked skipped: the honest state
	 * of an in-memory fake, and a loud gap for a transactional adapter.
	 */
	providesRolledBackRuns?: boolean;
}

const pos = (
	aggregateVersion: number,
	commitSequence: number,
): ProjectionPosition => ({ aggregateVersion, commitSequence });

const order = (aggregateId: string): AggregateAddress => ({
	aggregateType: "Order",
	aggregateId,
});

/**
 * The projection-checkpoint-store contract test suite: the proof that
 * an adapter delivers the watermark semantics the `Projector`
 * documents. Checkpoint semantics are an **adapter contract, not a
 * kit guarantee**; this suite is how an adapter demonstrates them.
 *
 * Framework-agnostic: bind with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export function createProjectionCheckpointStoreContractTests<TCtx>(
	harness: ProjectionCheckpointStoreContractHarness<TCtx>,
): ProjectionCheckpointStoreContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());

	return [
		{
			name: "a never-seen (projection, aggregate) pair loads undefined",
			run: inEnv(async (env) => {
				const loaded = await env.run((ctx) =>
					env.store.load(ctx, "order-list", order("o-1")),
				);
				assertEqual(
					loaded,
					undefined,
					"a fresh store must report no watermark",
				);
			}),
		},
		{
			name: "save/load round-trips the exact (aggregateVersion, commitSequence) pair",
			run: inEnv(async (env) => {
				await env.run((ctx) =>
					env.store.save(ctx, "order-list", order("o-1"), pos(5, 2)),
				);
				const loaded = await env.run((ctx) =>
					env.store.load(ctx, "order-list", order("o-1")),
				);
				assert(
					loaded?.aggregateVersion === 5 && loaded?.commitSequence === 2,
					"the stored watermark must round-trip both fields of the pair",
				);
			}),
		},
		{
			name: "save overwrites the previous watermark (last write wins; monotonicity is the projector's job)",
			run: inEnv(async (env) => {
				await env.run(async (ctx) => {
					await env.store.save(ctx, "order-list", order("o-1"), pos(5, 0));
					await env.store.save(ctx, "order-list", order("o-1"), pos(5, 1));
				});
				const loaded = await env.run((ctx) =>
					env.store.load(ctx, "order-list", order("o-1")),
				);
				assert(
					loaded?.aggregateVersion === 5 && loaded?.commitSequence === 1,
					"a later save must replace the stored watermark verbatim",
				);
			}),
		},
		{
			name: "a loaded position is a detached copy; mutating it must not move the watermark",
			run: inEnv(async (env) => {
				await env.run((ctx) =>
					env.store.save(ctx, "order-list", order("o-1"), pos(2, 0)),
				);
				const loaded = await env.run((ctx) =>
					env.store.load(ctx, "order-list", order("o-1")),
				);
				assert(loaded !== undefined, "expected a stored watermark");
				loaded.aggregateVersion = 99;
				const reloaded = await env.run((ctx) =>
					env.store.load(ctx, "order-list", order("o-1")),
				);
				assert(
					reloaded?.aggregateVersion === 2,
					"the stored watermark must be immune to mutation of a previously loaded copy",
				);
			}),
		},
		{
			name: "watermarks are isolated per projection and per aggregate",
			run: inEnv(async (env) => {
				await env.run(async (ctx) => {
					await env.store.save(ctx, "order-list", order("o-1"), pos(3, 0));
					await env.store.save(ctx, "order-detail", order("o-1"), pos(1, 0));
					await env.store.save(ctx, "order-list", order("o-2"), pos(7, 0));
				});
				const [listO1, detailO1, listO2] = await env.run((ctx) =>
					Promise.all([
						env.store.load(ctx, "order-list", order("o-1")),
						env.store.load(ctx, "order-detail", order("o-1")),
						env.store.load(ctx, "order-list", order("o-2")),
					]),
				);
				assert(
					listO1?.aggregateVersion === 3 &&
						detailO1?.aggregateVersion === 1 &&
						listO2?.aggregateVersion === 7,
					"the watermark key is the (projection, aggregateType, aggregateId) triple; no part may bleed into another",
				);
			}),
		},
		{
			name: "watermarks are isolated per aggregate TYPE: colliding raw ids do not share a checkpoint",
			run: inEnv(async (env) => {
				await env.run(async (ctx) => {
					await env.store.save(
						ctx,
						"order-list",
						{ aggregateType: "Order", aggregateId: "1" },
						pos(10, 0),
					);
					await env.store.save(
						ctx,
						"order-list",
						{ aggregateType: "Payment", aggregateId: "1" },
						pos(1, 0),
					);
				});
				const [orderMark, paymentMark] = await env.run((ctx) =>
					Promise.all([
						env.store.load(ctx, "order-list", {
							aggregateType: "Order",
							aggregateId: "1",
						}),
						env.store.load(ctx, "order-list", {
							aggregateType: "Payment",
							aggregateId: "1",
						}),
					]),
				);
				assert(
					orderMark?.aggregateVersion === 10 &&
						paymentMark?.aggregateVersion === 1,
					"identities are type-scoped: Order 1 at version 10 must not make Payment 1 look processed",
				);
			}),
		},
		{
			name: "address encoding is collision-free even with separator-like characters in either half",
			run: inEnv(async (env) => {
				// The two classic composite-key collisions: a separator
				// smuggled into the type vs. into the id. Whatever encoding
				// the adapter uses (composite column, JSON tuple, nested
				// key), these addresses must keep distinct watermarks.
				const inType: AggregateAddress = {
					aggregateType: "A\u0000B",
					aggregateId: "C",
				};
				const inId: AggregateAddress = {
					aggregateType: "A",
					aggregateId: "B\u0000C",
				};
				await env.run(async (ctx) => {
					await env.store.save(ctx, "order-list", inType, pos(10, 0));
					await env.store.save(ctx, "order-list", inId, pos(1, 0));
				});
				const [first, second] = await env.run((ctx) =>
					Promise.all([
						env.store.load(ctx, "order-list", inType),
						env.store.load(ctx, "order-list", inId),
					]),
				);
				assert(
					first?.aggregateVersion === 10 && second?.aggregateVersion === 1,
					"two addresses that differ only in where a hostile separator sits must not share a watermark",
				);
			}),
		},
		{
			name: "hasReached compares the full pair: unseen is false, behind is false, at and past are true",
			run: inEnv(async (env) => {
				await env.run((ctx) =>
					env.store.save(ctx, "order-list", order("o-1"), pos(5, 0)),
				);
				assertEqual(
					await env.store.hasReached("order-list", order("o-2"), pos(1, 0)),
					false,
					"an unseen aggregate has reached nothing",
				);
				assertEqual(
					await env.store.hasReached("order-list", order("o-1"), pos(5, 1)),
					false,
					"a later commitSequence of the SAME version is not yet reached; comparing on the version alone would lie mid-commit",
				);
				assertEqual(
					await env.store.hasReached("order-list", order("o-1"), pos(6, 0)),
					false,
					"a later version is not yet reached",
				);
				assertEqual(
					await env.store.hasReached("order-list", order("o-1"), pos(5, 0)),
					true,
					"the stored position itself is reached",
				);
				assertEqual(
					await env.store.hasReached("order-list", order("o-1"), pos(4, 7)),
					true,
					"any earlier version is reached regardless of its commitSequence",
				);
			}),
		},
		{
			name: "reset clears only the named projection's checkpoints",
			run: inEnv(async (env) => {
				await env.run(async (ctx) => {
					await env.store.save(ctx, "order-list", order("o-1"), pos(3, 0));
					await env.store.save(ctx, "order-detail", order("o-1"), pos(2, 0));
				});
				await env.run((ctx) => env.store.reset(ctx, "order-list"));
				const [cleared, untouched] = await env.run((ctx) =>
					Promise.all([
						env.store.load(ctx, "order-list", order("o-1")),
						env.store.load(ctx, "order-detail", order("o-1")),
					]),
				);
				assertEqual(
					cleared,
					undefined,
					"the reset projection must start from zero (rebuild entry point)",
				);
				assert(
					untouched?.aggregateVersion === 2,
					"a sibling projection's checkpoints must survive the reset",
				);
				assertEqual(
					await env.store.hasReached("order-list", order("o-1"), pos(1, 0)),
					false,
					"hasReached must report false after a reset",
				);
			}),
		},
		gatedContractTest(
			{
				capability: "providesRolledBackRuns",
				satisfiedBy: harness.providesRolledBackRuns === true,
			},
			{
				name: "a rolled-back save leaves no checkpoint behind (atomic update+checkpoint)",
				run: inEnv(async (env) => {
					if (!env.runRolledBack) {
						throw new Error(
							"Contract violated: harness declared providesRolledBackRuns but the environment lacks runRolledBack",
						);
					}
					await env
						.runRolledBack((ctx) =>
							env.store.save(ctx, "order-list", order("o-1"), pos(1, 0)),
						)
						.catch(() => {
							// The rollback mechanism may surface as a rejection; the
							// contract under test is the store state afterwards.
						});
					const loaded = await env.run((ctx) =>
						env.store.load(ctx, "order-list", order("o-1")),
					);
					assertEqual(
						loaded,
						undefined,
						"a checkpoint from a rolled-back transaction must not exist; otherwise events are lost while marked processed",
					);
				}),
			},
		),
	];
}
