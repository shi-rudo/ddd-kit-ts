import { describe, expect, it } from "vitest";
import type { AggregateAddress } from "../aggregate/aggregate-address";
import type { DomainEvent } from "../aggregate/domain-event";
import { EventSourcedAggregate } from "../aggregate/event-sourced-aggregate";
import { UnitOfWork, type UnitOfWorkSession } from "../app/unit-of-work";
import { ConcurrencyConflictError } from "../core/errors";
import type { Id } from "../core/id";
import type {
	CommittedDomainEvent,
	EventCommitCandidate,
	Outbox,
} from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import {
	createEsRepositoryContractTests,
	type EsContractRepository,
	type EsRepositoryContractHarness,
} from "./es-repository-contract";

/**
 * The in-memory REFERENCE adapter for the event-sourced contract suite:
 * the example consumers copy when wiring their own harness. It follows
 * every documented pattern: identity-map read path, bare-instance
 * reconstitution via `loadFromHistory`, enroll-before-append, and a
 * REAL expectedVersion guard on append (the `WHERE stream_version = ?`
 * equivalent) against a store with genuine transactional rollback.
 *
 * It is an EXAMPLE, not a proof: passing the suite in memory proves the
 * reference, not your adapter. SQL-backed event stores must run the
 * same suite against a real database.
 */

type EsOrderId = Id<"EsContractOrderId">;
type EsOrderState = { name: string; items: string[] };
type EsOrderCreated = DomainEvent<"EsOrderCreated", { name: string }>;
type EsOrderRenamed = DomainEvent<"EsOrderRenamed", { name: string }>;
type EsItemAdded = DomainEvent<"EsItemAdded", { item: string }>;
type EsOrderEvent = EsOrderCreated | EsOrderRenamed | EsItemAdded;

const orderStream = (id: EsOrderId): AggregateAddress<EsOrderId> => ({
	aggregateType: "ContractEsOrder",
	aggregateId: id,
});

const streamMapKey = (stream: AggregateAddress): string =>
	JSON.stringify([stream.aggregateType, stream.aggregateId]);

class ContractEsOrder extends EventSourcedAggregate<
	EsOrderState,
	EsOrderEvent,
	EsOrderId
> {
	protected readonly aggregateType = "ContractEsOrder";

	protected constructor(id: EsOrderId) {
		super(id, { name: "", items: [] });
	}

	/** Fresh aggregate: applies exactly ONE creation event (version 1). */
	static create(id: EsOrderId): ContractEsOrder {
		const order = new ContractEsOrder(id);
		order.apply(
			order.recordEvent("EsOrderCreated", {
				name: "initial",
			}) as EsOrderCreated,
		);
		return order;
	}

	/** Bare instance for replay: no events applied, version 0. */
	static bare(id: EsOrderId): ContractEsOrder {
		return new ContractEsOrder(id);
	}

	rename(name: string): void {
		this.apply(this.recordEvent("EsOrderRenamed", { name }) as EsOrderRenamed);
	}

	addItem(item: string): void {
		this.apply(this.recordEvent("EsItemAdded", { item }) as EsItemAdded);
	}

	protected readonly handlers = {
		EsOrderCreated: (
			state: EsOrderState,
			event: EsOrderCreated,
		): EsOrderState => ({ ...state, name: event.payload.name }),
		EsOrderRenamed: (
			state: EsOrderState,
			event: EsOrderRenamed,
		): EsOrderState => ({ ...state, name: event.payload.name }),
		EsItemAdded: (state: EsOrderState, event: EsItemAdded): EsOrderState => ({
			...state,
			items: [...state.items, event.payload.item],
		}),
	};
}

/**
 * In-memory streams + outbox with genuine transactional semantics via
 * snapshot/restore (same pattern as the state-stored reference; events
 * are deeply frozen, so shallow array copies suffice).
 */
class InMemoryEsDb {
	streams = new Map<string, EsOrderEvent[]>();
	outbox: CommittedDomainEvent<EsOrderEvent>[] = [];
	sourceHeads = new Map<string, number>();
	commitPredecessors = new Map<string, number | null>();

	addToOutbox(events: ReadonlyArray<EventCommitCandidate<EsOrderEvent>>): void {
		for (const message of events) {
			const sourceKey = JSON.stringify([
				message.source.aggregateType,
				message.source.aggregateId,
			]);
			const commitKey = JSON.stringify([
				message.source.aggregateType,
				message.source.aggregateId,
				message.position.aggregateVersion,
			]);
			let previousEventfulAggregateVersion: number | null;
			if (this.commitPredecessors.has(commitKey)) {
				previousEventfulAggregateVersion =
					this.commitPredecessors.get(commitKey) ?? null;
			} else {
				previousEventfulAggregateVersion =
					this.sourceHeads.get(sourceKey) ?? null;
				this.commitPredecessors.set(
					commitKey,
					previousEventfulAggregateVersion,
				);
				this.sourceHeads.set(sourceKey, message.position.aggregateVersion);
			}
			this.outbox.push({
				...message,
				position: { ...message.position, previousEventfulAggregateVersion },
			});
		}
	}

	snapshot(): {
		streams: Map<string, EsOrderEvent[]>;
		outbox: CommittedDomainEvent<EsOrderEvent>[];
		sourceHeads: Map<string, number>;
		commitPredecessors: Map<string, number | null>;
	} {
		return {
			streams: new Map(
				[...this.streams].map(([id, events]) => [id, [...events]]),
			),
			outbox: [...this.outbox],
			sourceHeads: new Map(this.sourceHeads),
			commitPredecessors: new Map(this.commitPredecessors),
		};
	}

	restore(snapshot: {
		streams: Map<string, EsOrderEvent[]>;
		outbox: CommittedDomainEvent<EsOrderEvent>[];
		sourceHeads: Map<string, number>;
		commitPredecessors: Map<string, number | null>;
	}): void {
		this.streams = snapshot.streams;
		this.outbox = snapshot.outbox;
		this.sourceHeads = snapshot.sourceHeads;
		this.commitPredecessors = snapshot.commitPredecessors;
	}
}

class InMemoryEsOrderRepository
	implements EsContractRepository<ContractEsOrder>
{
	constructor(
		protected readonly db: InMemoryEsDb,
		protected readonly session: UnitOfWorkSession<EsOrderEvent>,
	) {}

	async findById(id: EsOrderId): Promise<ContractEsOrder | null> {
		const cached = this.session.identityMap.get(ContractEsOrder, id);
		if (cached) return cached;
		if (this.session.identityMap.isDeleted(ContractEsOrder, id)) return null;

		const history = this.db.streams.get(streamMapKey(orderStream(id)));
		if (!history || history.length === 0) return null;
		const order = ContractEsOrder.bare(id);
		const result = order.loadFromHistory(history);
		if (result.isErr()) throw result.error; // corrupt stream
		this.session.identityMap.set(ContractEsOrder, id, order);
		return order;
	}

	async save(order: ContractEsOrder): Promise<void> {
		if (order.pendingEvents.length === 0) {
			return; // nothing to append; skipping save is safe for ES
		}
		// Enroll FIRST (the deleted-gate and harvest rely on it); a failed
		// append rolls the whole unit of work back anyway.
		this.session.enrollSaved(order);
		// The REAL expectedVersion guard: the in-memory equivalent of an
		// append predicated on the current stream version.
		const expectedVersion = order.persistedVersion ?? 0;
		const key = streamMapKey(orderStream(order.id));
		const stream = this.db.streams.get(key) ?? [];
		if (stream.length !== expectedVersion) {
			throw new ConcurrencyConflictError({
				aggregateType: "ContractEsOrder",
				aggregateId: order.id,
				expectedVersion,
				actualVersion: stream.length,
			});
		}
		// Appends the UNSTAMPED pendingEvents originals (the outbox gets
		// committed envelopes from withCommit's harvest).
		this.db.streams.set(key, [...stream, ...order.pendingEvents]);
	}
}

type EsRepoFactory = (
	db: InMemoryEsDb,
	session: UnitOfWorkSession<EsOrderEvent>,
) => EsContractRepository<ContractEsOrder>;

/** The harness consumers copy; `repoFactory` only parameterizes mutants. */
function createInMemoryEsHarness(
	repoFactory: EsRepoFactory = (db, session) =>
		new InMemoryEsOrderRepository(db, session),
): EsRepositoryContractHarness<ContractEsOrder, EsOrderEvent> {
	let mutationCounter = 0;
	let idCounter = 0;

	return {
		createEnvironment: async () => {
			const db = new InMemoryEsDb();
			const scope: TransactionScope<undefined> = {
				transactional: async <T>(fn: (_ctx: undefined) => Promise<T>) => {
					const snapshot = db.snapshot();
					try {
						return await fn(undefined);
					} catch (error) {
						db.restore(snapshot);
						throw error;
					}
				},
			};
			const outbox: Outbox<EsOrderEvent> = {
				add: async (events) => {
					db.addToOutbox(events);
				},
				getPending: async () =>
					db.outbox.map((message, i) => ({
						...message,
						dispatchId: String(i),
					})),
				markDispatched: async () => {},
			};
			return {
				run: (work) =>
					new UnitOfWork({
						scope,
						outbox,
						repositories: {
							orders: (
								_tx: undefined,
								session: UnitOfWorkSession<EsOrderEvent>,
							) => repoFactory(db, session),
						},
					}).run(({ repositories }) =>
						work({ repository: repositories.orders }),
					),
				committedOutboxEvents: async () => [...db.outbox],
				// The suite's window into the store: same read-and-slice
				// semantics as EventStore.readStream({ fromVersion }).
				committedStreamEvents: async (stream, fromVersion = 0) =>
					(db.streams.get(streamMapKey(stream)) ?? []).slice(
						Math.max(0, fromVersion),
					),
			};
		},
		streamKeyFor: orderStream,
		createAggregate: () =>
			ContractEsOrder.create(`contract-es-order-${idCounter++}` as EsOrderId),
		createAggregateWithId: (id) => ContractEsOrder.create(id),
		mutate: (order) => order.rename(`renamed-${mutationCounter++}`),
		snapshotState: (order) => order.createSnapshot().state,
	};
}

describe("event-sourced repository contract test suite (in-memory reference adapter)", () => {
	const tests = createEsRepositoryContractTests(createInMemoryEsHarness());

	it("the full-capability reference harness has no skipped tests", () => {
		expect(tests.filter((t) => t.skipped)).toHaveLength(0);
	});

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("marks the duplicate-create test as skipped without createAggregateWithId; a naive run() fails loud", async () => {
		const minimal = createInMemoryEsHarness();
		minimal.createAggregateWithId = undefined;

		const minimalTests = createEsRepositoryContractTests(minimal);

		expect(minimalTests).toHaveLength(tests.length);
		const skipped = minimalTests.filter((t) => t.skipped);
		expect(skipped.map((t) => t.skipped?.capability)).toEqual([
			"createAggregateWithId",
		]);
		await expect(skipped[0]?.run()).rejects.toThrow(
			/capability 'createAggregateWithId' is not provided/,
		);
	});

	/** Mutant pinning: the suite must EXPOSE broken adapters. */
	async function expectMutantFails(
		repoFactory: EsRepoFactory,
		testNamePrefix: string,
		expectedFailure: RegExp,
	): Promise<void> {
		const mutantTest = createEsRepositoryContractTests(
			createInMemoryEsHarness(repoFactory),
		).find((t) => t.name.startsWith(testNamePrefix));
		expect(mutantTest).toBeDefined();
		expect(mutantTest?.skipped).toBeUndefined();
		await expect(mutantTest?.run()).rejects.toThrow(expectedFailure);
	}

	// Mutant: append without the expectedVersion guard (blind append).
	class BlindAppendRepository extends InMemoryEsOrderRepository {
		override async save(order: ContractEsOrder): Promise<void> {
			if (order.pendingEvents.length === 0) return;
			this.session.enrollSaved(order);
			// ❌ no expectedVersion check:
			const key = streamMapKey(orderStream(order.id));
			const stream = this.db.streams.get(key) ?? [];
			this.db.streams.set(key, [...stream, ...order.pendingEvents]);
		}
	}

	it("the suite EXPOSES a blind append: no expectedVersion guard fails the mandatory test", async () => {
		await expectMutantFails(
			(db, session) => new BlindAppendRepository(db, session),
			"MANDATORY",
			/the second writer's commit must reject/,
		);
	});

	it("the suite EXPOSES a wrong fold order: a reversed read fails the replay-equality test", async () => {
		class ReversedReadRepository extends InMemoryEsOrderRepository {
			override async findById(id: EsOrderId): Promise<ContractEsOrder | null> {
				const cached = this.session.identityMap.get(ContractEsOrder, id);
				if (cached) return cached;
				const history = this.db.streams.get(streamMapKey(orderStream(id)));
				if (!history || history.length === 0) return null;
				const order = ContractEsOrder.bare(id);
				// ❌ folds newest-first (a SELECT without ORDER BY, unlucky):
				const result = order.loadFromHistory([...history].reverse());
				if (result.isErr()) throw result.error;
				this.session.identityMap.set(ContractEsOrder, id, order);
				return order;
			}
		}

		await expectMutantFails(
			(db, session) => new ReversedReadRepository(db, session),
			"replay equality",
			/must fold to the same state/,
		);
	});
});
