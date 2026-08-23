import type { IAggregateRoot, Version } from "../aggregate/aggregate";
import type {
	AnyDomainEvent,
	PendingDomainEvent,
} from "../aggregate/domain-event";
import {
	AggregateDeletedError,
	EventHarvestError,
	type InfrastructureError,
	isInfrastructureErrorLike,
	UnenrolledChangesError,
} from "../core/errors";
import type { Id } from "../core/id";
import type { EventBus, OutboxWriter } from "../events/ports";
import { type AggregateClass, IdentityMap } from "../repo/identity-map";
import {
	capturePersistenceBaseline,
	derivePersistenceChanges,
	insertPersistenceBaseline,
	type PersistenceBaseline,
	type PersistenceChanges,
	type PersistenceModel,
	persistenceProjectionDrifted,
	recapturePersistenceBaseline,
} from "../repo/persistence-model";
import type { TransactionScope } from "../repo/scope";
import { abortReason } from "../utils/abort";
import type { ExecutionContext } from "../utils/execution";
import {
	AggregateTrackingError,
	CommitError,
	InvalidRepositoryDefinitionError,
	NestedUnitOfWorkError,
	RepositoryErrorMappingFailedError,
	RollbackError,
	TransactionClosedError,
} from "./errors";
import {
	type AggregateCommitToken,
	type CommitEnrollment,
	withCommit,
} from "./handler";
import type {
	AggregatePersistenceWrite,
	AggregateWriteIntent,
	RepositoryTracking,
	RuntimePersistenceDefinition,
	UnitOfWorkIdentityMap,
} from "./persistence-contract";
import { bindRepositoryWrites } from "./repository-facade";


interface RuntimeRepositoryDefinition<Evt extends AnyDomainEvent, TCtx>
	extends RuntimePersistenceDefinition<Evt> {
	readonly create: (
		transaction: TCtx,
		tracking: RepositoryTracking<IAggregateRoot<Id<string>, Evt>>,
	) => unknown;
}


/**
 * What the application work callback receives: repositories already bound to
 * the live Unit of Work plus cooperative cancellation.
 *
 * The adapter-only transaction and tracking capability are deliberately absent.
 * Exposing either would let application code bypass repository lifecycle
 * registration and would leak infrastructure types into the use case.
 */
export interface UnitOfWorkContext<TRepos> {
	readonly repositories: TRepos;

	/**
	 * The cooperative-cancellation signal passed to {@link UnitOfWork.run},
	 * or `undefined` if none was given. Poll `signal?.aborted` between
	 * steps of a long operation and throw `signal.reason` to bail out; the
	 * throw rolls the unit of work back like any other callback error. The
	 * kit does not interrupt an in-flight query for you: actual query
	 * cancellation depends on the `TransactionScope` honoring the signal.
	 */
	readonly signal?: AbortSignal;
}

/** Options for a single {@link UnitOfWork.run} call. */
export interface RunOptions {
	/**
	 * Cooperative-cancellation signal. If already aborted, `run()` rejects
	 * with the signal's `reason` before opening a transaction. Otherwise it
	 * is exposed on the context (poll `context.signal`) and forwarded to the
	 * `TransactionScope`. Use `AbortSignal.timeout(ms)` for a deadline.
	 */
	readonly signal?: AbortSignal;
}

// Shared across package copies like every other kit brand: a definition
// built by a bundled plugin copy's defineRepository must be accepted by the
// host copy's UnitOfWork. The key version stamps the definition SHAPE; bump
// it when the definition contract changes so an incompatible copy fails the
// generic not-a-definition check instead of half-working.
const repositoryDefinitionBrand: unique symbol = Symbol.for(
	"@shirudo/ddd-kit/repository-definition/v1",
);

/** Adapter wiring accepted by {@link defineRepository}. */
export interface RepositoryDefinitionOptions<
	TCtx,
	TRepositoryPort extends object,
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
	TBaseline,
	TChangeSet,
	TRemoval extends boolean = false,
> {
	/** Concrete aggregate class used as the Identity Map key. */
	readonly aggregate: AggregateClass<TAggregate>;
	/** Adapter-owned projection, baseline, and change-set policy. */
	readonly persistence: PersistenceModel<TAggregate, TBaseline, TChangeSet>;
	/**
	 * Creates the transaction-bound adapter for the port's non-lifecycle
	 * methods. The Unit of Work supplies `add`, `update`, and optional `remove`.
	 */
	readonly create: (
		transaction: TCtx,
		tracking: RepositoryTracking<TAggregate>,
	) => Omit<TRepositoryPort, "add" | "update" | "remove">;
	/**
	 * Performs the registered write during the Unit of Work's commit phase.
	 *
	 * The receipt contains adapter-owned changes and immutable persistence
	 * facts, never the mutable aggregate instance. The transaction remains open
	 * while this function and the outbox write run.
	 */
	readonly flush: (
		transaction: NoInfer<TCtx>,
		write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
	) => void | Promise<void>;
	/**
	 * Translates every adapter/driver failure from `flush` into an explicit
	 * application-facing infrastructure error. Returning or throwing a raw
	 * driver error is a wiring failure and is rejected by the Unit of Work.
	 */
	readonly mapError: (
		error: unknown,
		write: AggregatePersistenceWrite<TAggregate, TChangeSet>,
	) => InfrastructureError;
	/** Adds Unit-of-Work-owned `remove` to the application-facing repository. */
	readonly physicalRemoval?: TRemoval;
}

/** Complete, helper-created definition for one Unit-of-Work repository. */
export interface RepositoryDefinition<
	TCtx,
	TRepositoryPort extends object,
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
	TBaseline,
	TChangeSet,
	TRemoval extends boolean = false,
> extends RepositoryDefinitionOptions<
		TCtx,
		TRepositoryPort,
		TAggregate,
		TBaseline,
		TChangeSet,
		TRemoval
	> {
	/** Nominal marker installed by {@link defineRepository}. */
	readonly [repositoryDefinitionBrand]: true;
}


/** @inline */
type CallableValue = (...args: never[]) => unknown;

/** @inline */
type RepositoryDefinitionBuilder<TRepositoryPort extends object> = <
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
	TCreate extends (
		transaction: never,
		tracking: RepositoryTracking<TAggregate>,
	) => Omit<TRepositoryPort, "add" | "update" | "remove">,
	TBaseline,
	TChangeSet,
	TRemoval extends boolean = false,
>(
	definition: RepositoryDefinitionOptions<
		Parameters<TCreate>[0],
		TRepositoryPort,
		TAggregate,
		TBaseline,
		TChangeSet,
		TRemoval
	> & {
		readonly create: TCreate;
	} & (TRepositoryPort extends AggregateWriteRegistration<TAggregate>
			? TRemoval extends true
				? TRepositoryPort extends PhysicalRemovalRegistration<TAggregate>
					? unknown
					: never
				: TRepositoryPort extends PhysicalRemovalRegistration<TAggregate>
					? never
					: unknown
			: never),
) => RepositoryDefinition<
	Parameters<TCreate>[0],
	TRepositoryPort,
	TAggregate,
	TBaseline,
	TChangeSet,
	TRemoval
>;

/**
 * Defines repository wiring for an application-owned driven port.
 *
 * The first call makes the port explicit; the second infers the transaction,
 * aggregate, persistence, event, and removal types from the adapter wiring.
 * The port must declare `add` and `update`; if it declares `remove`, the
 * definition must set `physicalRemoval: true`. The adapter created by the
 * definition implements only the remaining methods because lifecycle writes
 * are installed by the Unit of Work.
 * The returned definition is the only form accepted by {@link UnitOfWork}; a
 * raw adapter-shaped object cannot silently turn its concrete surface into the
 * application contract.
 */
function assertRepositoryDefinitionMembers(
	definition: Record<PropertyKey, unknown>,
): void {
	for (const key of ["create", "flush", "mapError"] as const) {
		if (typeof definition[key] !== "function") {
			throw new TypeError(
				`defineRepository: "${key}" is missing or not a function on the ` +
					"definition. The builder copies own enumerable properties only; " +
					"prototype methods and non-enumerable members are not carried. " +
					"Pass a plain object literal.",
			);
		}
	}
	if (typeof definition.aggregate !== "function") {
		throw new TypeError(
			'defineRepository: "aggregate" is missing or not a class reference ' +
				"on the definition. Pass a plain object literal with own " +
				"enumerable properties.",
		);
	}
	if (
		definition.persistence === null ||
		typeof definition.persistence !== "object"
	) {
		throw new TypeError(
			'defineRepository: "persistence" is missing or not a ' +
				"PersistenceModel on the definition. Pass a plain object literal " +
				"with own enumerable properties.",
		);
	}
}

export function defineRepository<TRepositoryPort extends object>(): Extract<
	TRepositoryPort,
	CallableValue
> extends never
	? RepositoryDefinitionBuilder<TRepositoryPort>
	: never {
	const builder = (definition: object): object => {
		const branded = { ...definition };
		// Validated AFTER the spread, on what actually survives it: the
		// spread copies own enumerable properties only, so create/flush/
		// mapError carried on a prototype (class instance) or as
		// non-enumerable members vanish silently. Without this check, the
		// loss surfaces as a bare TypeError deep inside the first run().
		assertRepositoryDefinitionMembers(branded as Record<PropertyKey, unknown>);
		Object.defineProperty(branded, repositoryDefinitionBrand, {
			configurable: false,
			enumerable: false,
			value: true,
			writable: false,
		});
		return Object.freeze(branded);
	};
	return builder as unknown as Extract<
		TRepositoryPort,
		CallableValue
	> extends never
		? RepositoryDefinitionBuilder<TRepositoryPort>
		: never;
}

/** Application-facing repositories inferred from their adapter definitions. */
export type RepositoriesOf<TDefinitions> = {
	[K in keyof TDefinitions]: RepositoryFacadeOf<TDefinitions[K]>;
};

/**
 * Preserves each concrete repository definition while rejecting incomplete
 * entries, callable adapter results, and definitions whose transaction context
 * or aggregate event family does not belong to the Unit of Work that owns them.
 */
export type CompatibleRepositoryDefinitions<
	Evt extends AnyDomainEvent,
	TCtx,
	TDefinitions,
> = {
	[K in keyof TDefinitions]: TDefinitions[K] extends RepositoryDefinition<
		infer TDefinitionContext,
		infer _TRepositoryPort,
		infer TAggregate,
		infer _TBaseline,
		infer _TChangeSet,
		infer _TRemoval
	>
		? TAggregate extends IAggregateRoot<Id<string>, infer TDefinitionEvent>
			? [TDefinitionEvent] extends [Evt]
				? TCtx extends TDefinitionContext
					? TDefinitions[K]
					: never
				: never
			: never
		: never;
};

/** @inline */
type RepositoryFacadeOf<TDefinition> = TDefinition extends RepositoryDefinition<
	infer _TCtx,
	infer TRepositoryPort,
	infer _TAggregate,
	infer _TBaseline,
	infer _TChangeSet,
	infer _TRemoval
>
	? TRepositoryPort
	: never;

/** Unit-of-Work-owned writes added to every application repository facade. */
export interface AggregateWriteRegistration<
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
> {
	add(aggregate: TAggregate): void;
	update(aggregate: TAggregate): void;
}

/** Optional physical removal added only by an explicit repository definition. */
export interface PhysicalRemovalRegistration<
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
> {
	remove(aggregate: TAggregate): void;
}

/** Dependencies for {@link UnitOfWork}; the app-level singleton part. */
export interface UnitOfWorkDeps<
	Evt extends AnyDomainEvent,
	TCtx,
	TDefinitions extends Record<string, unknown>,
> {
	scope: TransactionScope<TCtx>;
	/**
	 * The write half of the outbox; see `WithCommitDeps.outbox` for the
	 * required-vs-optional-bus asymmetry and the explicit opt-out
	 * (`outboxWriterAcceptingEventLoss`).
	 */
	outbox: OutboxWriter<Evt>;
	bus?: EventBus<Evt>;
	/** See `withCommit`: observer for post-commit `bus.publish` failures. */
	onPublishError?: (error: unknown, events: ReadonlyArray<Evt>) => void;
	/**
	 * See `withCommit`: application-shell observer after acknowledgement.
	 * The version argument is captured before any observer runs; the context
	 * carries the bounded post-commit execution signal and deadline.
	 */
	onPersisted?: (
		aggregate: IAggregateRoot<Id<string>, Evt>,
		version: Version,
		context: ExecutionContext,
	) => void | Promise<void>;
	/**
	 * See `withCommit`: failure observer for internal post-commit
	 * acknowledgement/disposal and the application-shell `onPersisted`
	 * callback. Never rejects the committed write.
	 */
	onPersistError?: (
		error: unknown,
		aggregate: IAggregateRoot<Id<string>, Evt>,
	) => void;
	/**
	 * See `withCommit`: one total budget shared by the complete post-commit
	 * application phase. Default `30000`ms.
	 */
	postCommitTimeoutMs?: number;
	repositories: CompatibleRepositoryDefinitions<Evt, TCtx, TDefinitions>;
}

/**
 * Explicit-intent Unit of Work: one `run()` call is one application-level
 * write operation. All repository writes inside the callback share one
 * transaction and either persist completely or not at all.
 *
 * Built ON TOP of `withCommit` - the commit orchestration (event
 * harvest into the outbox inside the transaction, internal acknowledgement
 * after the commit, best-effort in-process publish last) is inherited,
 * not reimplemented. What this layer adds:
 *
 * - **Tx-bound repository adapters via a registry.** The callback receives
 *   application-facing repository facades and never sees the raw transaction
 *   or tracking capability.
 * - **Unit-of-Work-owned writes.** Standard `add`, `update`, and `remove`
 *   methods register lifecycle intent. Adapter implementations with those
 *   names are not invoked through the facade.
 * - **Lifecycle errors.** {@link NestedUnitOfWorkError},
 *   {@link TransactionClosedError}, {@link CommitError},
 *   {@link RollbackError}, {@link AggregateDeletedError}.
 *
 * - **A per-operation Identity Map and expected-version receipt.** Read paths
 *   call `trackLoaded` before returning an aggregate. The Unit of Work then
 *   owns the one-instance rule and the optimistic-concurrency expectation.
 * - **Persistence-last guard.** Once write intent is registered, a later
 *   version or event-batch change rejects the operation before commit.
 *
 * Nested transactions, savepoints, and transaction joining remain outside
 * this boundary. One `run()` is one consistency transaction.
 *
 * **Instance discipline:** one instance owns one logical operation at
 * a time. `run()` while a run is active throws
 * {@link NestedUnitOfWorkError} - that covers genuine nesting AND two
 * concurrent requests sharing one instance, which is the same bug in
 * different clothes. Construct one `UnitOfWork` per operation
 * (construction stores one reference; the shareable singleton is the
 * deps object). Sequential reuse of an instance is fine.
 *
 * **Error pass-through:** an error thrown by the work callback (a
 * repository's `ConcurrencyConflictError`, a `DomainError`, anything)
 * is rethrown UNCHANGED - the unit of work never converts a concurrency
 * conflict into a generic error. Only the two failure modes the
 * callback cannot observe are wrapped: see {@link CommitError} and
 * {@link RollbackError}.
 *
 * @example
 * ```ts
 * const deps = {
 *   scope: drizzleScope,
 *   outbox: drizzleOutbox,
 *   bus: eventBus,
 *   repositories: {
 *     restaurants: restaurantRepositoryDefinition,
 *   },
 * };
 *
 * const uow = new UnitOfWork(deps);
 * const result = await uow.run(async ({ repositories }) => {
 *   const restaurant = await repositories.restaurants.getById(id);
 *   restaurant.changeOpeningHours(openingHours);
 *   repositories.restaurants.update(restaurant);
 *   return restaurant.id;
 * });
 * ```
 */
export class UnitOfWork<
	Evt extends AnyDomainEvent,
	TCtx,
	TDefinitions extends Record<string, unknown>,
> {
	private _active = false;

	constructor(private readonly deps: UnitOfWorkDeps<Evt, TCtx, TDefinitions>) {}

	/**
	 * Execute one unit of work: open the transaction, hand the callback
	 * tx-bound repositories, commit on resolve, roll back on throw,
	 * run the post-commit lifecycle (acknowledge, observe, publish) for every
	 * enrolled aggregate. Returns the callback's result.
	 */
	public async run<R>(
		work: (
			context: UnitOfWorkContext<RepositoriesOf<TDefinitions>>,
		) => Promise<R>,
		options?: RunOptions,
	): Promise<R> {
		// Pre-flight: an already-aborted caller rejects with the signal's
		// reason before opening a transaction (no callback runs). Placed
		// before the active-guard so a doubly-bad call (aborted signal on an
		// already-running instance) is reported as aborted rather than as a
		// nesting error. The `??` fallback mirrors event-bus.ts and guards a
		// non-spec polyfill whose `reason` is undefined.
		if (options?.signal?.aborted) {
			throw abortReason(
				options.signal,
				"UnitOfWork.run aborted before opening a transaction",
			);
		}
		if (this._active) {
			throw new NestedUnitOfWorkError();
		}
		this._active = true;

		let session: Session<Evt> | undefined;
		let workCompleted = false;
		let workThrew = false;
		let workError: unknown;

		try {
			return await withCommit<Evt, R, TCtx>(
				{
					outbox: this.deps.outbox,
					bus: this.deps.bus,
					scope: this.deps.scope,
					onPublishError: this.deps.onPublishError,
					onPersisted: this.deps.onPersisted,
					onPersistError: this.deps.onPersistError,
					postCommitTimeoutMs: this.deps.postCommitTimeoutMs,
					signal: options?.signal,
				},
				async (tx, enrollment) => {
					// Fresh state per scope invocation: a TransactionScope that
					// retries its callback (serialization-failure retry wrappers)
					// re-runs this fn, and state from the rolled-back attempt
					// (enrollments, identity-map entries, error flags) must not
					// leak into the retry. The previous attempt's session is
					// closed so its leaked contexts turn loud.
					session?.close();
					const s = new Session<Evt>(enrollment);
					session = s;
					workCompleted = false;
					workThrew = false;
					workError = undefined;

					const repositories = this.buildRepositories(tx, s);
					const context = makeContext(repositories, s, options?.signal);
					try {
						const result = await work(context);
						// Validate tracking before sealing: a loaded aggregate that
						// changed without update intent would otherwise be lost.
						// Throws inside
						// the transaction, so the unit of work rolls back.
						s.assertReadyToCommit();
						await s.flush(tx);
						// A flush may yield to the event loop. Re-check before the
						// transaction is allowed to commit so leaked concurrent work
						// cannot mutate an already registered aggregate mid-flush.
						s.assertReadyToCommit();
						workCompleted = true;
						// Seal immediately: the aggregates snapshot below is what
						// gets harvested. A late registration from work still in
						// flight must throw
						// TransactionClosedError instead of being silently
						// accepted-but-never-harvested.
						const commits = s.commitTokens;
						s.close();
						return { result, commits };
					} catch (error) {
						workThrew = true;
						workError = error;
						throw error;
					}
				},
			);
		} catch (error) {
			throw classifyRunError(error, {
				workThrew,
				workCompleted,
				workError,
				signal: options?.signal,
			});
		} finally {
			session?.close();
			this._active = false;
		}
	}

	private buildRepositories(
		tx: TCtx,
		session: Session<Evt>,
	): RepositoriesOf<TDefinitions> {
		const repositories = {} as RepositoriesOf<TDefinitions>;
		for (const key of Object.keys(this.deps.repositories) as Array<
			keyof TDefinitions
		>) {
			const candidate = this.deps.repositories[key] as unknown;
			if (!isRepositoryDefinition(candidate)) {
				throw new InvalidRepositoryDefinitionError(String(key));
			}
			const definition = candidate as RuntimeRepositoryDefinition<Evt, TCtx>;
			const adapter = definition.create(tx, session.trackingFor(definition));
			repositories[key] = bindRepositoryWrites(
				adapter,
				session,
				definition,
				String(key),
			) as RepositoriesOf<TDefinitions>[typeof key];
		}
		return repositories;
	}
}

function isRepositoryDefinition(value: unknown): value is object {
	if (value === null || typeof value !== "object") return false;
	try {
		const marker = Reflect.getOwnPropertyDescriptor(
			value,
			repositoryDefinitionBrand,
		);
		return (
			marker?.value === true &&
			marker.configurable === false &&
			marker.enumerable === false &&
			marker.writable === false &&
			Object.isFrozen(value)
		);
	} catch {
		return false;
	}
}

type AggregateLifecycle = "new" | "loaded";

/**
 * The immutable receipt one add/update/remove registration freezes: intent,
 * exact version and event batch, the sealed persistence baseline, and the
 * derived change set. It exists as ONE optional unit so registration,
 * rollback, and flush cannot half-apply it; `registration === undefined`
 * means "tracked but no write registered".
 */
interface WriteRegistration<Evt extends AnyDomainEvent> {
	readonly intent: AggregateWriteIntent;
	readonly version: Version;
	readonly events: ReadonlyArray<PendingDomainEvent<Evt>>;
	readonly baseline: PersistenceBaseline<
		IAggregateRoot<Id<string>, Evt>,
		unknown
	>;
	readonly changes: PersistenceChanges<unknown>;
}

interface TrackedAggregate<Evt extends AnyDomainEvent> {
	readonly aggregate: IAggregateRoot<Id<string>, Evt>;
	readonly lifecycle: AggregateLifecycle;
	readonly expectedVersion: Version | undefined;
	readonly definition: RuntimePersistenceDefinition<Evt>;
	readonly baseline: PersistenceBaseline<
		IAggregateRoot<Id<string>, Evt>,
		unknown
	>;
	registration?: WriteRegistration<Evt>;
}

/** Internal session implementation; closed by `run()`'s finally. */
class Session<Evt extends AnyDomainEvent> {
	// Read tracking order is independent of write registration order. Flush
	// follows this list so adapters observe the same explicit order as the use
	// case's add/update/remove calls. Enrollment and removal state are NOT
	// separate collections: both derive from each entry's registration, so
	// the bookkeeping cannot drift apart.
	private readonly _registeredWrites: TrackedAggregate<Evt>[] = [];
	private readonly _commitTokens = new Set<AggregateCommitToken<Evt>>();
	private readonly _identityMap = new IdentityMap();
	// What adapters receive: the typed read-only view, enforced at runtime.
	// Handing out the map itself would expose set/delete/clear to JavaScript
	// callers, and a stray clear() erases deletion tombstones and the
	// pending-event baselines behind UnenrolledChangesError.
	private readonly _identityMapView = Object.freeze({
		get: this._identityMap.get.bind(this._identityMap),
		has: this._identityMap.has.bind(this._identityMap),
		isDeleted: this._identityMap.isDeleted.bind(this._identityMap),
	}) as UnitOfWorkIdentityMap;
	private readonly _trackingByAggregate = new WeakMap<
		IAggregateRoot<Id<string>, Evt>,
		TrackedAggregate<Evt>
	>();
	private readonly _trackedAggregates = new Set<TrackedAggregate<Evt>>();
	private _closed = false;

	constructor(private readonly commitEnrollment: CommitEnrollment<Evt>) {}

	public get identityMap(): UnitOfWorkIdentityMap {
		this.assertOpen("tracking.identityMap");
		return this._identityMapView;
	}

	public trackingFor(
		definition: RuntimePersistenceDefinition<Evt>,
	): RepositoryTracking<IAggregateRoot<Id<string>, Evt>> {
		const session = this;
		return Object.freeze({
			get identityMap() {
				return session.identityMap;
			},
			trackLoaded: (aggregate: IAggregateRoot<Id<string>, Evt>) =>
				session.trackLoaded(aggregate, definition),
		});
	}

	/** The registration of an instance, or undefined when none is tracked. */
	private registrationOf(
		aggregate: object,
	): WriteRegistration<Evt> | undefined {
		return this._trackingByAggregate.get(
			aggregate as IAggregateRoot<Id<string>, Evt>,
		)?.registration;
	}

	/** Whether THIS instance registered a remove in this session. */
	private isRemovedInstance(aggregate: object): boolean {
		return this.registrationOf(aggregate)?.intent === "remove";
	}

	private trackLoaded<TAggregate extends IAggregateRoot<Id<string>, Evt>>(
		aggregate: TAggregate,
		definition: RuntimePersistenceDefinition<Evt>,
	): TAggregate {
		this.assertOpen("tracking.trackLoaded");
		// Ownership is checked BEFORE identity-map registration: a rejected
		// instance must not stay registered under the second definition's
		// class key with no tracking entry behind it.
		const existing = this._trackingByAggregate.get(aggregate);
		if (existing && existing.definition !== definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				"load",
				"different_repository",
				existing.registration?.intent,
			);
		}
		this._identityMap.set(definition.aggregate, aggregate.id, aggregate);
		if (existing) return aggregate;

		const entry: TrackedAggregate<Evt> = {
			aggregate,
			lifecycle: "loaded",
			expectedVersion: aggregate.version,
			definition,
			baseline: capturePersistenceBaseline(definition.persistence, aggregate),
		};
		this._trackingByAggregate.set(aggregate, entry);
		this._trackedAggregates.add(entry);
		return aggregate;
	}

	public add(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		this.assertOpen("repository.add");
		this.assertNotRemoved(aggregate, definition);
		const existing = this._trackingByAggregate.get(aggregate);
		if (existing && existing.definition !== definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				"add",
				"different_repository",
				existing.registration?.intent,
			);
		}
		if (existing?.lifecycle === "loaded") {
			throw new AggregateTrackingError(
				String(aggregate.id),
				"add",
				"loaded_as_new",
				existing.registration?.intent,
			);
		}

		let entry = existing;
		const newlyTracked = !entry;
		if (!entry) {
			this._identityMap.set(definition.aggregate, aggregate.id, aggregate);
			entry = {
				aggregate,
				lifecycle: "new",
				expectedVersion: undefined,
				definition,
				baseline: insertPersistenceBaseline(definition.persistence),
			};
			this._trackingByAggregate.set(aggregate, entry);
			this._trackedAggregates.add(entry);
		}

		try {
			this.registerWrite(entry, "add", definition);
		} catch (error) {
			// A failed add must not leave a phantom: without this rollback,
			// findById would serve the never-persisted instance from the
			// identity map while the commit-readiness guard ignores "new"
			// lifecycle entries, so the transaction would commit without a
			// write for it.
			if (newlyTracked) {
				this._trackingByAggregate.delete(aggregate);
				this._trackedAggregates.delete(entry);
				this._identityMap.discard(definition.aggregate, aggregate.id, aggregate);
			}
			throw error;
		}
	}

	public update(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		this.assertOpen("repository.update");
		const entry = this.loadedEntryFor(aggregate, "update", definition);
		this.registerWrite(entry, "update", definition);
	}

	public remove(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		this.assertOpen("repository.remove");
		// Idempotent by reference, like add and update: a repeated remove of
		// the SAME instance re-declares the same final lifecycle outcome
		// (collection semantics; the enrollment layer already returns the
		// same token for a repeat enrollDeleted). The deletion-finality gate
		// stays sharp for everything else: add, update, and trackLoaded
		// after remove, and any OTHER instance with the same id, still
		// reject.
		const entry = this._trackingByAggregate.get(aggregate);
		if (this.isRemovedInstance(aggregate) && entry?.definition === definition) {
			return;
		}
		const loaded = this.loadedEntryFor(aggregate, "remove", definition);
		this.registerWrite(loaded, "remove", definition);
	}

	/** Registers persistence intent and commit enrollment as one operation. */
	private registerWrite(
		entry: TrackedAggregate<Evt>,
		intent: AggregateWriteIntent,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		const newlyRegistered = this.registerIntent(entry, intent);
		try {
			if (intent === "remove") {
				this.registerRemovedCommit(
					entry.aggregate,
					definition,
					entry.expectedVersion,
				);
			} else {
				this.registerSavedCommit(
					entry.aggregate,
					definition,
					entry.expectedVersion,
				);
			}
		} catch (error) {
			if (newlyRegistered) this.rollbackIntentRegistration(entry);
			throw error;
		}
	}

	private loadedEntryFor(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		operation: "update" | "remove",
		definition: RuntimePersistenceDefinition<Evt>,
	): TrackedAggregate<Evt> {
		this.assertNotRemoved(aggregate, definition);
		const entry = this._trackingByAggregate.get(aggregate);
		// Repository-ownership violations report as such on every operation:
		// add and trackLoaded already use different_repository, and code
		// branching on the machine-readable reason must not get not_loaded
		// for the identical violation on the update/remove path.
		if (entry && entry.definition !== definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				operation,
				"different_repository",
				entry.registration?.intent,
			);
		}
		// An add()-registered aggregate IS tracked, just not "loaded": report
		// the real conflict with the registered intent. The not_loaded advice
		// ("load it through the repository") is impossible for an aggregate
		// that has no row yet and would actively mislead.
		if (
			entry &&
			entry.lifecycle === "new" &&
			entry.definition === definition
		) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				operation,
				"conflicting_intent",
				entry.registration?.intent,
			);
		}
		if (entry?.lifecycle !== "loaded" || entry.definition !== definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				operation,
				"not_loaded",
				entry?.registration?.intent,
			);
		}
		return entry;
	}

	private assertNotRemoved(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		if (this._identityMap.isDeleted(definition.aggregate, aggregate.id)) {
			throw new AggregateDeletedError(String(aggregate.id));
		}
	}

	private registerIntent(
		entry: TrackedAggregate<Evt>,
		intent: AggregateWriteIntent,
	): boolean {
		if (entry.registration !== undefined) {
			if (entry.registration.intent !== intent) {
				throw new AggregateTrackingError(
					String(entry.aggregate.id),
					intent,
					"conflicting_intent",
					entry.registration.intent,
				);
			}
			this.assertUnchangedAfterRegistration(entry);
			return false;
		}

		entry.registration = Object.freeze({
			intent,
			version: entry.aggregate.version,
			// Already a frozen detached copy from the pendingEvents getter.
			events: entry.aggregate.pendingEvents,
			baseline: recapturePersistenceBaseline(entry.baseline, entry.aggregate),
			changes: derivePersistenceChanges(entry.baseline, entry.aggregate),
		});
		this._registeredWrites.push(entry);
		return true;
	}

	/** Restores the pre-registration state when commit enrollment rejects. */
	private rollbackIntentRegistration(entry: TrackedAggregate<Evt>): void {
		const index = this._registeredWrites.lastIndexOf(entry);
		if (index >= 0) this._registeredWrites.splice(index, 1);
		delete entry.registration;
	}

	private assertUnchangedAfterRegistration(entry: TrackedAggregate<Evt>): void {
		const registration = entry.registration;
		if (registration === undefined) return;
		const currentEvents = entry.aggregate.pendingEvents;
		// Capture-to-capture drift, NOT changes().isEmpty(): the
		// PersistenceModel contract permits full-replacement change sets that
		// are never empty, so a non-empty change set proves nothing about
		// mutation after registration.
		const persistenceChanged = persistenceProjectionDrifted(
			registration.baseline,
			entry.aggregate,
		);
		const sameEvents =
			currentEvents.length === registration.events.length &&
			currentEvents.every(
				(event, index) => event === registration.events[index],
			);
		if (
			registration.version !== entry.aggregate.version ||
			!sameEvents ||
			persistenceChanged
		) {
			throw new AggregateTrackingError(
				String(entry.aggregate.id),
				"commit",
				"mutated_after_registration",
				registration.intent,
			);
		}
	}

	private registerSavedCommit(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
		expectedVersion: Version | undefined,
	): AggregateCommitToken<Evt> {
		this.assertOpen("repository.add/update");
		// Two gates, one invariant: the registration check catches the same
		// reference; the identity-map tombstone (keyed on the instance's
		// concrete class) catches a DIFFERENT instance with the same
		// type+id: e.g. one re-created via the static factory after the
		// delete. Both mean "deleted is final within this operation".
		if (
			this.isRemovedInstance(aggregate) ||
			this._identityMap.isDeleted(definition.aggregate, aggregate.id)
		) {
			throw new AggregateDeletedError(String(aggregate.id));
		}
		const token = this.commitEnrollment.enrollSaved(aggregate, {
			expectedVersion,
		});
		this._commitTokens.add(token);
		return token;
	}

	private registerRemovedCommit(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
		expectedVersion: Version | undefined,
	): AggregateCommitToken<Evt> {
		this.assertOpen("repository.remove");
		const token = this.commitEnrollment.enrollDeleted(aggregate, {
			expectedVersion,
		});
		// One call does ALL the deletion bookkeeping: the identity-map
		// entry is removed and tombstoned automatically (keyed on the
		// instance's concrete class), so repositories do not need a
		// second manual identityMap.delete() call; a forgotten leg of a
		// two-call protocol would silently weaken the deletion gate. The
		// removed state itself derives from the entry's registration.
		// Assumption (documented on IdentityMap): repositories key the
		// map with the same concrete class their factories produce.
		// Deleted aggregates stay in the harvest set: their recorded
		// deletion events must reach the outbox (repository.md, hard-
		// delete with event harvest). withCommit receives them in the
		// deleted token disposition, so the saved-only application observer
		// never fires for a deletion.
		this._identityMap.delete(definition.aggregate, aggregate.id);
		this._commitTokens.add(token);
		return token;
	}

	/**
	 * End-of-run safety net. A loaded aggregate whose version or pending event
	 * batch changed without `update` intent would otherwise be silently lost.
	 * An aggregate that changed after registration could persist state and
	 * events from different moments. Both violations reject inside the
	 * transaction.
	 */
	public assertReadyToCommit(): void {
		for (const entry of this._trackedAggregates) {
			if (entry.registration !== undefined) {
				this.assertUnchangedAfterRegistration(entry);
				continue;
			}
			// Capture-to-capture drift against the load-time baseline: a
			// full-replacement model's changes() is never empty, which would
			// misreport every merely-loaded aggregate as unenrolled changes.
			if (
				entry.lifecycle === "loaded" &&
				(entry.aggregate.version !== entry.expectedVersion ||
					persistenceProjectionDrifted(entry.baseline, entry.aggregate))
			) {
				throw new UnenrolledChangesError(String(entry.aggregate.id));
			}
		}

		for (const instance of this._identityMap.instancesWithNewPendingEvents()) {
			// Any registration (add, update, or remove) means the instance is
			// enrolled and its batch will be harvested.
			if (
				instance !== null &&
				typeof instance === "object" &&
				this.registrationOf(instance) !== undefined
			) {
				continue;
			}
			// Events were recorded on a loaded aggregate after it was
			// registered, yet it has no write intent: a forgotten update whose
			// events would be silently dropped.
			const id = (instance as { id?: unknown }).id;
			throw new UnenrolledChangesError(String(id));
		}
	}

	/** Flushes every registered receipt in deterministic registration order. */
	public async flush(transaction: unknown): Promise<void> {
		this.assertOpen("unitOfWork.flush");
		for (const entry of this._registeredWrites) {
			const registration = entry.registration;
			if (registration === undefined) {
				throw new AggregateTrackingError(
					String(entry.aggregate.id),
					"commit",
					"mutated_after_registration",
				);
			}
			const write = Object.freeze({
				intent: registration.intent,
				aggregateId: entry.aggregate.id,
				expectedVersion: entry.expectedVersion,
				version: registration.version,
				changes: registration.changes,
				events: registration.events,
			}) as AggregatePersistenceWrite<IAggregateRoot<Id<string>, Evt>, unknown>;
			try {
				await entry.definition.flush(transaction, write);
			} catch (error) {
				throw mapRepositoryPersistenceError(entry.definition, error, write);
			}
		}
	}

	public get commitTokens(): ReadonlyArray<AggregateCommitToken<Evt>> {
		return [...this._commitTokens];
	}

	public close(): void {
		this._closed = true;
		// Defensive: a leaked direct IdentityMap reference must not serve
		// stale instances into a later operation (that would silently
		// bypass OCC). The session getter already throws after close;
		// clearing covers refs captured before.
		this._identityMap.clear();
		this._trackedAggregates.clear();
		this._registeredWrites.length = 0;
		this._commitTokens.clear();
	}

	public assertOpen(operation: string): void {
		if (this._closed) {
			throw new TransactionClosedError(operation);
		}
	}
}

function mapRepositoryPersistenceError<Evt extends AnyDomainEvent>(
	definition: RuntimePersistenceDefinition<Evt>,
	error: unknown,
	write: AggregatePersistenceWrite<IAggregateRoot<Id<string>, Evt>, unknown>,
): InfrastructureError {
	let mapped: unknown;
	try {
		mapped = definition.mapError(error, write);
	} catch (mapperError) {
		throw new RepositoryErrorMappingFailedError({
			aggregateId: String(write.aggregateId),
			intent: write.intent,
			persistenceError: error,
			mapperError,
		});
	}
	// Copy-safe: an adapter package can carry its own copy of the kit, whose
	// InfrastructureError fails a plain instanceof here; rejecting it would
	// turn every retryable conflict into a non-retryable wiring crash that
	// blames a correct mapper.
	if (isInfrastructureErrorLike(mapped)) return mapped;
	throw new RepositoryErrorMappingFailedError({
		aggregateId: String(write.aggregateId),
		intent: write.intent,
		persistenceError: error,
		mapperError: new TypeError(
			"Repository mapError must return an InfrastructureError instance",
		),
	});
}

function makeContext<TRepos, Evt extends AnyDomainEvent>(
	repositories: TRepos,
	session: Session<Evt>,
	signal: AbortSignal | undefined,
): UnitOfWorkContext<TRepos> {
	return {
		get repositories(): TRepos {
			session.assertOpen("context.repositories");
			return repositories;
		},
		// The caller's own signal: exposed directly, not gated by
		// assertOpen, so polling `aborted` after close stays harmless.
		signal,
	};
}

/**
 * Classifies a `withCommit` rejection into the error `run()` should throw,
 * using the flags captured inside the work wrapper. Pure and total: it
 * returns the error to throw rather than throwing itself, so `run()` reads
 * as orchestration and this decision is unit-testable in isolation.
 *
 * - `workThrew`: the work callback (or `assertAllChangesEnrolled`) threw.
 *   The scope normally rethrows that error unchanged (rolled back, pass
 *   through so a `ConcurrencyConflictError` & co. stay catchable as-is); a
 *   scope that WRAPS the original is detected via the cause chain and also
 *   passed through. Only a rejection that neither IS nor wraps the
 *   callback's error indicates the rollback itself failed, which becomes a
 *   {@link RollbackError}.
 * - `workCompleted`: the callback finished; the failure is post-completion.
 *   A harvest-guard violation (an event missing aggregateId / aggregateType,
 *   or an eventful persisted aggregate that did not advance its version) is a deterministic
 *   programming bug, surfaced as its {@link EventHarvestError} (which does
 *   NOT extend `InfrastructureError`, so a retry-on-Infrastructure handler
 *   skips it). It is thrown inside `scope.transactional()`, so a wrapping
 *   scope can nest it: walk the chain rather than a bare `instanceof`. Only
 *   genuinely unforeseeable post-completion failures (outbox write, the
 *   commit itself) become {@link CommitError}.
 * - Neither flag set: `withCommit` rejected before the callback ran (the
 *   scope failed to even open a transaction); pass the error through.
 */
function classifyRunError(
	error: unknown,
	state: {
		readonly workThrew: boolean;
		readonly workCompleted: boolean;
		readonly workError: unknown;
		readonly signal: AbortSignal | undefined;
	},
): unknown {
	// Cancellation wins over the attempt flags: a scope that rejects with
	// the caller's abort reason between retry attempts never re-enters the
	// work callback, so workThrew/workError still describe the PREVIOUS
	// attempt. Classifying by those stale flags would mislabel the abort as
	// a RollbackError carrying a retryable cause, inviting a retry of an
	// explicitly cancelled operation.
	if (
		state.signal?.aborted &&
		state.signal.reason !== undefined &&
		(error === state.signal.reason ||
			causeChainContains(error, state.signal.reason))
	) {
		return error;
	}
	if (state.workThrew) {
		if (
			error === state.workError ||
			causeChainContains(error, state.workError)
		) {
			return error;
		}
		return new RollbackError(state.workError, error);
	}
	if (state.workCompleted) {
		const harvestError = findHarvestErrorInChain(error);
		if (harvestError) {
			return harvestError;
		}
		return new CommitError(error);
	}
	return error;
}

/**
 * Cycle-safe, getter-throw-safe walk over `error`'s standard `cause`
 * chain. `visit` runs for every object link (the top error included) and
 * receives the link plus its lazily read `cause`; a non-undefined return
 * stops the walk. A throwing `cause` getter (lazy deserialization, revoked
 * Proxy) ends the walk as no-match instead of replacing the real failure
 * with the getter's exception.
 */
function findInCauseChain<T>(
	error: unknown,
	visit: (link: object, cause: unknown) => T | undefined,
): T | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (
		current !== null &&
		typeof current === "object" &&
		!seen.has(current)
	) {
		seen.add(current);
		let cause: unknown;
		try {
			cause = (current as { cause?: unknown }).cause;
		} catch {
			return undefined;
		}
		const found = visit(current, cause);
		if (found !== undefined) return found;
		current = cause;
	}
	return undefined;
}

/**
 * Walks `error`'s `cause` chain and returns the first `EventHarvestError`,
 * or `undefined`. `withCommit` throws the harvest-guard error INSIDE
 * `scope.transactional`, so a wrapping scope can nest it; matching
 * only the top-level error would let the wrapper mask the non-retryable
 * type. `withCommit` and `run()` share this module, so the local
 * `instanceof` is reliable for the un-wrapped link.
 */
function findHarvestErrorInChain(
	error: unknown,
): EventHarvestError | undefined {
	return findInCauseChain(error, (link) =>
		link instanceof EventHarvestError ? link : undefined,
	);
}

/**
 * Whether `error`'s `cause` chain contains `target` by reference. A
 * `target` of `undefined`/`null` never matches: every error without a
 * `cause` property would otherwise "contain" a thrown `undefined`.
 */
function causeChainContains(error: unknown, target: unknown): boolean {
	if (target === undefined || target === null) {
		return false;
	}
	return (
		findInCauseChain(error, (_link, cause) =>
			cause === target ? true : undefined,
		) ?? false
	);
}
