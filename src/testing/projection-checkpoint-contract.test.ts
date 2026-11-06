import { describe, expect, it } from "vite-plus/test";
import { InMemoryProjectionCheckpointStore } from "../application/projections/adapters/in-memory-checkpoint-store";
import type {
	ProjectionCheckpoint,
	ProjectionPosition,
} from "../application/projections/ports";
import type { AggregateIdentity } from "../domain/aggregate/aggregate-identity";
import { InMemoryTransactionScope } from "../persistence/repository/adapters/in-memory-transaction-scope";
import {
	createProjectionCheckpointStoreContractTests,
	type ProjectionCheckpointStoreContractHarness,
} from "./projection-checkpoint-contract";

const ROLLBACK = Symbol("rollback");

/**
 * A store that rejects a NUL byte in an aggregate type, but cuts an aggregate id
 * at its first NUL byte, as a C string does.
 */
class StoreThatCutsAnIdAtNul extends InMemoryProjectionCheckpointStore {
	override load(
		ctx: unknown,
		projection: string,
		identity: AggregateIdentity,
	): Promise<ProjectionCheckpoint | undefined> {
		return super.load(ctx, projection, cutAtNul(identity));
	}

	override save(
		ctx: unknown,
		projection: string,
		identity: AggregateIdentity,
		checkpoint: ProjectionCheckpoint,
	): Promise<void> {
		return super.save(ctx, projection, cutAtNul(identity), checkpoint);
	}

	override hasReached(
		projection: string,
		identity: AggregateIdentity,
		position: ProjectionPosition,
	): Promise<boolean> {
		return super.hasReached(projection, cutAtNul(identity), position);
	}
}

function cutAtNul(identity: AggregateIdentity): AggregateIdentity {
	if (identity.aggregateType.includes("\u0000")) {
		throw new TypeError(
			"the store cannot keep a NUL byte in an aggregate type",
		);
	}
	const [cutId = ""] = identity.aggregateId.split("\u0000");
	return { aggregateType: identity.aggregateType, aggregateId: cutId };
}

function createInMemoryHarness(
	createStore = () => new InMemoryProjectionCheckpointStore(),
): ProjectionCheckpointStoreContractHarness<unknown> {
	return {
		createEnvironment: async () => {
			const store = createStore();
			const scope = new InMemoryTransactionScope([store]);
			return {
				store,
				run: (work) => scope.transactional(work),
				// The scope runs one transaction at a time, so concurrent runs
				// bypass it.
				runConcurrently: (works) =>
					Promise.all(works.map((work) => work(undefined))),
				runRolledBack: async (work) => {
					let result: Awaited<ReturnType<typeof work>> | undefined;
					await scope
						.transactional(async (ctx) => {
							result = await work(ctx);
							throw ROLLBACK;
						})
						.catch((error: unknown) => {
							if (error !== ROLLBACK) throw error;
						});
					return result as Awaited<ReturnType<typeof work>>;
				},
			};
		},
		providesConcurrentRuns: true,
		providesRolledBackRuns: true,
	};
}

describe("projection-checkpoint-store contract suite against the in-memory reference", () => {
	const tests = createProjectionCheckpointStoreContractTests(
		createInMemoryHarness(),
	);

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("no test is skipped for the in-memory reference", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
	});

	it("the identity test kills a store that cuts an aggregate id at a NUL byte", async () => {
		const identityTest = createProjectionCheckpointStoreContractTests(
			createInMemoryHarness(() => new StoreThatCutsAnIdAtNul()),
		).find(
			(test) =>
				test.name ===
				"aggregate identity encoding is collision-free even with separator-like characters in either half",
		);

		await expect(identityTest?.run()).rejects.toThrow(/Contract violated/);
	});
});
