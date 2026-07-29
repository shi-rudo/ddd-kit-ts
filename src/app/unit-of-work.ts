import type { IAggregateRoot, Version } from "../aggregate/aggregate";
import type {
	AnyDomainEvent,
	PendingDomainEvent,
} from "../aggregate/domain-event";
import {
	AggregateDeletedError,
	EventHarvestError,
	InfrastructureError,
	KitWiringError,
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
	recapturePersistenceBaseline,
} from "../repo/persistence-model";
import type { TransactionScope } from "../repo/scope";
import { abortReason } from "../utils/abort";
import type { ExecutionContext } from "../utils/execution";
import {
	type AggregateCommitToken,
	type CommitEnrollment,
	withCommit,
} from "./handler";

/**
 * Thrown when `UnitOfWork.run()` is called while the same instance is
 * already executing a unit of work: either a genuinely nested `run()`
 * inside the work callback, or two concurrent operations sharing one
 * instance.
 *
 * Both are contract violations, not recoverable infrastructure
 * failures, so this carries the `WIRING` category (same reasoning as
 * `MissingHandlerError`): a generic `catch (e instanceof
 * InfrastructureError)` handler must not mask it.
 *
 * A nested `run()` would NOT join the outer transaction; it would open
 * an independent one, silently breaking the all-or-nothing guarantee.
 * If two operations must commit together, they are ONE unit of work:
 * merge them into a single `run()` callback. For concurrent requests,
 * construct one `UnitOfWork` per operation (construction is trivially
 * cheap; the dependency object is the thing you share).
 */
export class NestedUnitOfWorkError extends KitWiringError<"NESTED_UNIT_OF_WORK"> {
	constructor() {
		super(
			"NESTED_UNIT_OF_WORK",
			"UnitOfWork.run() was called while this instance is already running. " +
				"A nested run() would open an independent transaction, not join the " +
				"outer one - merge the work into a single run() callback. For " +
				"concurrent operations, construct one UnitOfWork per operation.",
		);
	}
}

interface RuntimePersistenceDefinition<Evt extends AnyDomainEvent> {
	readonly aggregate: AggregateClass<IAggregateRoot<Id<string>, Evt>>;
	readonly persistence: PersistenceModel<
		IAggregateRoot<Id<string>, Evt>,
		unknown,
		unknown
	>;
	readonly flush: (
		transaction: unknown,
		write: AggregatePersistenceWrite<IAggregateRoot<Id<string>, Evt>, unknown>,
	) => void | Promise<void>;
	readonly physicalRemoval?: boolean;
}

interface RuntimeRepositoryDefinition<Evt extends AnyDomainEvent, TCtx>
	extends RuntimePersistenceDefinition<Evt> {
	readonly create: (
		transaction: TCtx,
		tracking: RepositoryTracking<IAggregateRoot<Id<string>, Evt>>,
	) => unknown;
}

/**
 * Thrown when the unit-of-work context is used after `run()` has
 * settled: reading `context.repositories`, calling an adapter-held
 * `tracking.trackLoaded`, or using a repository facade after the transaction
 * has committed or rolled back.
 *
 * Use-after-close is a programming bug (typically a leaked context
 * reference or a fire-and-forget promise outliving the callback), so
 * this carries the `WIRING` category and should crash loud.
 *
 * **Honest scope of this guard:** the kit can only invalidate what it
 * controls: the context getters and tracking capability. An adapter that captures
 * its raw transaction handle can still call it as far as the kit can see;
 * whether the driver rejects after close is ORM-specific. Adapter factories
 * must not let that handle escape into application code.
 */
export class TransactionClosedError extends KitWiringError<"TRANSACTION_CLOSED"> {
	constructor(public readonly operation: string) {
		super(
			"TRANSACTION_CLOSED",
			`Unit of work is closed: ${operation} was called after the ` +
				"transaction committed or rolled back. Do not use the context or " +
				"repository facade or tracking capability outside the run() callback.",
		);
	}
}

/** A repository factory returned a value that cannot be wrapped as a facade. */
export class InvalidRepositoryAdapterError extends KitWiringError<"INVALID_REPOSITORY_ADAPTER"> {
	constructor(
		public readonly repository: string,
		public readonly receivedType: string,
	) {
		super(
			"INVALID_REPOSITORY_ADAPTER",
			`Repository factory "${repository}" returned ${receivedType}; ` +
				"it must return an adapter object.",
		);
	}
}

/** The explicit persistence intent registered for one tracked aggregate. */
export type AggregateWriteIntent = "add" | "update" | "remove";

/** Why an aggregate lifecycle registration was rejected. */
export type AggregateTrackingFailure =
	| "not_loaded"
	| "loaded_as_new"
	| "different_repository"
	| "conflicting_intent"
	| "mutated_after_registration";

/**
 * A deterministic violation of the Unit of Work's aggregate lifecycle.
 *
 * This is a wiring error rather than a domain or infrastructure failure: the
 * application registered persistence intent in an order the Unit of Work
 * cannot execute truthfully. Retrying the same callback cannot repair it.
 */
export class AggregateTrackingError extends KitWiringError<"AGGREGATE_TRACKING"> {
	constructor(
		public readonly aggregateId: string,
		public readonly operation: AggregateWriteIntent | "commit",
		public readonly reason: AggregateTrackingFailure,
		public readonly registeredIntent?: AggregateWriteIntent,
	) {
		super(
			"AGGREGATE_TRACKING",
			trackingFailureMessage(aggregateId, operation, reason, registeredIntent),
		);
	}
}

function trackingFailureMessage(
	aggregateId: string,
	operation: AggregateWriteIntent | "commit",
	reason: AggregateTrackingFailure,
	registeredIntent: AggregateWriteIntent | undefined,
): string {
	switch (reason) {
		case "not_loaded":
			return (
				`Aggregate ${aggregateId} cannot be registered for ${operation}: ` +
				"it was not loaded into this unit of work. Load it through the " +
				"repository before updating or removing it."
			);
		case "loaded_as_new":
			return (
				`Aggregate ${aggregateId} cannot be added as new because it was ` +
				"loaded by this unit of work. Use update for a loaded aggregate."
			);
		case "different_repository":
			return (
				`Aggregate ${aggregateId} cannot be registered for ${operation} through ` +
				"a different repository in the same unit of work. One aggregate instance " +
				"must remain owned by the repository definition that first tracked it."
			);
		case "conflicting_intent":
			return (
				`Aggregate ${aggregateId} is already registered for ` +
				`${registeredIntent ?? "another write"}; ${operation} would create ` +
				"conflicting persistence intent in one unit of work. Decide the final " +
				"lifecycle outcome before registering it."
			);
		case "mutated_after_registration":
			return (
				`Aggregate ${aggregateId} changed after ${registeredIntent ?? "write"} ` +
				"was registered. Make domain decisions first and call add, update, or " +
				"remove last so persisted state and recorded events cannot diverge."
			);
	}
}

/**
 * The unit of work failed AFTER the work callback completed
 * successfully, at the persistence boundary: the outbox write or the
 * transaction commit itself rejected. The kit cannot see inside
 * `TransactionScope.transactional`, so these are deliberately one error
 * class; the underlying failure is attached as `cause`.
 *
 * `InfrastructureError`: the business logic ran to completion; the
 * persistence boundary failed. The transaction rolled back (or never
 * committed), no aggregate was marked persisted, and pending events
 * survive on the aggregates; the operation left no partial state behind.
 * A `CommitError` is the **potentially transient** post-completion
 * failure (a commit-time serialization failure is the classic case), so
 * it is the one a retrying caller should consider re-running. The
 * deterministic post-completion failure, a harvest-guard violation (an
 * event missing `aggregateId` / `aggregateType`, or an eventful persisted
 * aggregate that did not advance its version), is a programming bug and surfaces as
 * {@link EventHarvestError} instead, which does NOT extend
 * `InfrastructureError`, so it stays out of retry paths by construction.
 */
export class CommitError extends InfrastructureError<"COMMIT_FAILED"> {
	constructor(cause: unknown) {
		super({
			code: "COMMIT_FAILED",
			message:
				"Unit of work failed after the work callback completed: the outbox " +
				"write or the transaction commit rejected. The transaction did " +
				"not commit; this failure may be transient, inspect the cause " +
				"(e.g. someChainRetryable) before retrying.",
			cause,
		});
	}
}

/**
 * The work callback threw AND the transaction scope rejected with a
 * DIFFERENT error that does not wrap the callback's error in its cause
 * chain - the strongest available signal that the rollback itself
 * failed. The callback's (primary) error is preserved as `cause`, so
 * cause-chain helpers (`someChainRetryable`, `findInCauseChain`) still
 * see a wrapped `ConcurrencyConflictError` & co.; the scope's error is
 * carried in {@link rollbackCause}.
 *
 * Scopes that rethrow the original error (Drizzle, Prisma do) never
 * produce this; scopes that WRAP the original are detected via the
 * cause chain and passed through unchanged instead.
 */
export class RollbackError extends InfrastructureError<"ROLLBACK_FAILED"> {
	constructor(
		cause: unknown,
		public readonly rollbackCause: unknown,
	) {
		super({
			code: "ROLLBACK_FAILED",
			message:
				"The work callback failed and the transaction scope rejected with a " +
				"different error (possible rollback failure). The callback's error " +
				"is the cause; the scope's error is in rollbackCause.",
			cause,
		});
	}
}

/** Read-only Identity Map operations available to repository adapters. */
export type UnitOfWorkIdentityMap = Pick<
	IdentityMap,
	"get" | "has" | "isDeleted"
>;

/**
 * Repository-specific tracking capability handed only to its adapter.
 *
 * Read paths call {@link RepositoryTracking.trackLoaded} before returning a
 * restored aggregate.
 * Write methods exposed to application code are replaced by Unit-of-Work-owned
 * `add`, `update`, and `remove` registrations, so an adapter implementation of
 * those methods cannot perform durable I/O early or skip event harvesting.
 *
 * Contract for repository implementations:
 * - `findById(id)` checks `identityMap.get` BEFORE hydrating, treats
 *   `identityMap.isDeleted` as not-found (`undefined`), and returns
 *   `tracking.trackLoaded(aggregate)` after hydration. This captures the
 *   expected version before application code can mutate the instance.
 * - Adapter objects may declare `add`, `update`, and `remove` to satisfy their
 *   consumer-owned port types, but the application-facing facade replaces
 *   those implementations with Unit-of-Work-owned registrations.
 * - Other repository methods are reads. A custom method that performs a write
 *   would bypass the Unit of Work and violates the adapter contract.
 */
export interface RepositoryTracking<
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
> {
	/**
	 * Registers an aggregate restored by a repository before returning it to
	 * application code. The Unit of Work identity-maps the instance and captures
	 * its current version as the optimistic-concurrency expectation.
	 */
	trackLoaded(aggregate: TAggregate): TAggregate;

	/**
	 * Read-only view of the per-operation Identity Map (Fowler): one aggregate type+id,
	 * one in-memory instance. Created fresh per `run()`, cleared on
	 * close; accessing it after close throws
	 * {@link TransactionClosedError}.
	 */
	readonly identityMap: UnitOfWorkIdentityMap;
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

/** Complete adapter definition for one Unit-of-Work repository. */
export interface RepositoryDefinition<
	TCtx,
	TRepository extends object,
	TAggregate extends IAggregateRoot<Id<string>, Evt>,
	TBaseline,
	TChangeSet,
	Evt extends AnyDomainEvent = AnyDomainEvent,
	TRemoval extends boolean = false,
> {
	/** Concrete aggregate class used as the Identity Map key. */
	readonly aggregate: AggregateClass<TAggregate>;
	/** Adapter-owned projection, baseline, and change-set policy. */
	readonly persistence: PersistenceModel<TAggregate, TBaseline, TChangeSet>;
	/** Creates the transaction-bound read adapter for one attempt. */
	readonly create: (
		transaction: TCtx,
		tracking: RepositoryTracking<TAggregate>,
	) => TRepository extends (...args: never[]) => unknown ? never : TRepository;
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
	/** Adds Unit-of-Work-owned `remove` to the application-facing repository. */
	readonly physicalRemoval?: TRemoval;
}

/**
 * Immutable adapter input for one registered aggregate write.
 *
 * `expectedVersion` is captured when a loaded aggregate joins the Unit of
 * Work and is absent for `add`. `version`, `changes`, and `events` describe
 * the exact moment at which the application registered its write intent.
 * Adapters must use the expected/current version pair for their OCC predicate
 * and must not read mutable write state back from an aggregate reference.
 */
export interface AggregatePersistenceWrite<
	TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>,
	TChangeSet,
> {
	readonly intent: AggregateWriteIntent;
	readonly aggregateId: TAggregate["id"];
	readonly expectedVersion: Version | undefined;
	readonly version: Version;
	readonly changes: PersistenceChanges<TChangeSet>;
	readonly events: TAggregate["pendingEvents"];
}

/** Preserves inference while making a repository definition explicit. */
export function defineRepository<
	TCtx,
	TRepository extends object,
	TAggregate extends IAggregateRoot<Id<string>, Evt>,
	TBaseline,
	TChangeSet,
	Evt extends AnyDomainEvent = AnyDomainEvent,
	TRemoval extends boolean = false,
>(
	definition: RepositoryDefinition<
		TCtx,
		TRepository,
		TAggregate,
		TBaseline,
		TChangeSet,
		Evt,
		TRemoval
	> &
		(TRepository extends (...args: never[]) => unknown ? never : unknown),
): RepositoryDefinition<
	TCtx,
	TRepository,
	TAggregate,
	TBaseline,
	TChangeSet,
	Evt,
	TRemoval
> {
	return Object.freeze({ ...definition });
}

/** Application-facing repositories inferred from their adapter definitions. */
export type RepositoriesOf<TDefinitions> = {
	[K in keyof TDefinitions]: RepositoryFacadeOf<TDefinitions[K]>;
};

/**
 * Preserves each concrete repository definition while rejecting entries whose
 * transaction context or aggregate event family does not belong to the Unit
 * of Work that owns them.
 */
export type CompatibleRepositoryDefinitions<
	Evt extends AnyDomainEvent,
	TCtx,
	TDefinitions,
> = {
	[K in keyof TDefinitions]: TDefinitions[K] extends {
		readonly create: (
			transaction: infer TDefinitionContext,
			tracking: infer _TTracking,
		) => unknown;
		readonly aggregate: AggregateClass<infer TAggregate>;
	}
		? TCtx extends TDefinitionContext
			? TAggregate extends IAggregateRoot<Id<string>, infer TDefinitionEvent>
				? [TDefinitionEvent] extends [Evt]
					? TDefinitions[K]
					: never
				: never
			: never
		: never;
};

type RepositoryFacadeOf<TDefinition> = TDefinition extends {
	readonly aggregate: AggregateClass<infer TAggregate>;
	readonly create: (...args: infer _Args) => infer TReadRepository;
}
	? TAggregate extends IAggregateRoot<Id<string>, AnyDomainEvent>
		? Omit<TReadRepository, "add" | "update" | "remove"> &
				AggregateWriteRegistration<TAggregate> &
				(TDefinition extends {
					readonly physicalRemoval?: infer TRemoval;
				}
					? TRemoval extends true
						? PhysicalRemovalRegistration<TAggregate>
						: object
					: object)
		: never
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
			const definition = this.deps.repositories[
				key
			] as unknown as RuntimeRepositoryDefinition<Evt, TCtx>;
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

/**
 * Builds the application-facing repository facade. Standard lifecycle writes
 * are always supplied by the Unit of Work; similarly named adapter methods are
 * never invoked. Other methods are bound to the adapter so classes with private
 * fields keep their normal receiver.
 */
function bindRepositoryWrites<TRepository, Evt extends AnyDomainEvent>(
	adapter: TRepository,
	session: Session<Evt>,
	definition: RuntimePersistenceDefinition<Evt>,
	repository: string,
): TRepository {
	if (adapter === null || typeof adapter !== "object") {
		throw new InvalidRepositoryAdapterError(
			repository,
			adapter === null ? "null" : typeof adapter,
		);
	}

	const source = adapter as object;
	const facadeTarget = Object.create(Reflect.getPrototypeOf(source)) as object;
	const methodCache = new Map<PropertyKey, (...args: unknown[]) => unknown>();
	const writes = new Set<PropertyKey>();
	const lifecycleOperations = new Set<PropertyKey>(["add", "update", "remove"]);
	const operationName = (property: PropertyKey): string =>
		`repository.${typeof property === "symbol" ? (property.description ?? property.toString()) : property}`;
	const readSource = (property: PropertyKey): unknown => {
		session.assertOpen(operationName(property));
		const value = Reflect.get(source, property, source);
		if (typeof value !== "function") return value;
		const cached = methodCache.get(property);
		if (cached) return cached;
		const guarded = (...args: unknown[]): unknown => {
			session.assertOpen(operationName(property));
			return Reflect.apply(value, source, args);
		};
		methodCache.set(property, guarded);
		return guarded;
	};
	const defineForwardedOwnProperty = (
		property: PropertyKey,
		descriptor: PropertyDescriptor,
	): void => {
		Object.defineProperty(facadeTarget, property, {
			configurable: true,
			enumerable: descriptor.enumerable ?? false,
			get: () => readSource(property),
			set:
				("value" in descriptor && descriptor.writable) || descriptor.set
					? (value: unknown) => {
							session.assertOpen(operationName(property));
							if (!Reflect.set(source, property, value, source)) {
								throw new TypeError(
									`Cannot assign to repository property ${String(property)}`,
								);
							}
						}
					: undefined,
		});
	};

	const operations = definition.physicalRemoval
		? (["add", "update", "remove"] as const)
		: (["add", "update"] as const);
	for (const operation of operations) {
		writes.add(operation);
		Object.defineProperty(facadeTarget, operation, {
			configurable: false,
			enumerable: false,
			writable: false,
			value: (aggregate: unknown) => {
				session.assertOpen(operationName(operation));
				session[operation](
					aggregate as IAggregateRoot<Id<string>, Evt>,
					definition,
				);
			},
		});
	}
	for (const property of Reflect.ownKeys(source)) {
		if (lifecycleOperations.has(property)) continue;
		const descriptor = Reflect.getOwnPropertyDescriptor(source, property);
		if (descriptor) defineForwardedOwnProperty(property, descriptor);
	}

	return new Proxy(facadeTarget, {
		get: (target, property, receiver) => {
			session.assertOpen(operationName(property));
			const own = Reflect.getOwnPropertyDescriptor(target, property);
			if (own) return Reflect.get(target, property, receiver);
			if (property === "remove") return undefined;
			return readSource(property);
		},
		set: (target, property, value, receiver) => {
			session.assertOpen(operationName(property));
			if (lifecycleOperations.has(property)) return false;
			if (Reflect.getOwnPropertyDescriptor(target, property)) {
				return Reflect.set(target, property, value, receiver);
			}
			if (!Reflect.isExtensible(target)) return false;
			const set = Reflect.set(source, property, value, source);
			const descriptor = Reflect.getOwnPropertyDescriptor(source, property);
			if (set && descriptor) defineForwardedOwnProperty(property, descriptor);
			return set;
		},
		has: (target, property) => {
			session.assertOpen(operationName(property));
			return (
				writes.has(property) ||
				(property !== "remove" &&
					(Reflect.has(target, property) || Reflect.has(source, property)))
			);
		},
		defineProperty: (target, property, descriptor) => {
			session.assertOpen(operationName(property));
			if (
				lifecycleOperations.has(property) &&
				!Reflect.getOwnPropertyDescriptor(target, property)
			) {
				return false;
			}
			return Reflect.defineProperty(target, property, descriptor);
		},
	}) as TRepository;
}

type AggregateLifecycle = "new" | "loaded";

interface TrackedAggregate<Evt extends AnyDomainEvent> {
	readonly aggregate: IAggregateRoot<Id<string>, Evt>;
	readonly lifecycle: AggregateLifecycle;
	readonly expectedVersion: Version | undefined;
	readonly definition: RuntimePersistenceDefinition<Evt>;
	readonly baseline: PersistenceBaseline<
		IAggregateRoot<Id<string>, Evt>,
		unknown
	>;
	intent?: AggregateWriteIntent;
	registeredVersion?: Version;
	registeredEvents?: ReadonlyArray<PendingDomainEvent<Evt>>;
	registeredBaseline?: PersistenceBaseline<
		IAggregateRoot<Id<string>, Evt>,
		unknown
	>;
	changes?: PersistenceChanges<unknown>;
}

/** Internal session implementation; closed by `run()`'s finally. */
class Session<Evt extends AnyDomainEvent> {
	// Insertion-ordered: harvest order = enrollment order (withCommit then
	// preserves per-aggregate emission order).
	private readonly _enrolled = new Set<IAggregateRoot<Id<string>, Evt>>();
	// Read tracking order is independent of write registration order. Flush
	// follows this list so adapters observe the same explicit order as the use
	// case's add/update/remove calls.
	private readonly _registeredWrites: TrackedAggregate<Evt>[] = [];
	private readonly _deleted = new Set<IAggregateRoot<Id<string>, Evt>>();
	private readonly _commitTokens = new Set<AggregateCommitToken<Evt>>();
	private readonly _identityMap = new IdentityMap();
	private readonly _trackingByAggregate = new WeakMap<
		IAggregateRoot<Id<string>, Evt>,
		TrackedAggregate<Evt>
	>();
	private readonly _trackedAggregates = new Set<TrackedAggregate<Evt>>();
	private _closed = false;

	constructor(private readonly commitEnrollment: CommitEnrollment<Evt>) {}

	public get identityMap(): IdentityMap {
		this.assertOpen("tracking.identityMap");
		return this._identityMap;
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

	private trackLoaded<TAggregate extends IAggregateRoot<Id<string>, Evt>>(
		aggregate: TAggregate,
		definition: RuntimePersistenceDefinition<Evt>,
	): TAggregate {
		this.assertOpen("tracking.trackLoaded");
		this._identityMap.set(definition.aggregate, aggregate.id, aggregate);

		const existing = this._trackingByAggregate.get(aggregate);
		if (existing) {
			if (existing.definition !== definition) {
				throw new AggregateTrackingError(
					String(aggregate.id),
					"update",
					"not_loaded",
					existing.intent,
				);
			}
			return aggregate;
		}

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
				existing.intent,
			);
		}
		if (existing?.lifecycle === "loaded") {
			throw new AggregateTrackingError(
				String(aggregate.id),
				"add",
				"loaded_as_new",
				existing.intent,
			);
		}

		let entry = existing;
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

		this.registerWrite(entry, "add", definition);
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
		const entry = this.loadedEntryFor(aggregate, "remove", definition);
		this.registerWrite(entry, "remove", definition);
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
		if (
			!entry ||
			entry.lifecycle !== "loaded" ||
			entry.definition !== definition
		) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				operation,
				"not_loaded",
				entry?.intent,
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
		if (entry.intent !== undefined) {
			if (entry.intent !== intent) {
				throw new AggregateTrackingError(
					String(entry.aggregate.id),
					intent,
					"conflicting_intent",
					entry.intent,
				);
			}
			this.assertUnchangedAfterRegistration(entry);
			return false;
		}

		entry.intent = intent;
		this._registeredWrites.push(entry);
		entry.registeredVersion = entry.aggregate.version;
		entry.registeredEvents = Object.freeze([...entry.aggregate.pendingEvents]);
		entry.registeredBaseline = recapturePersistenceBaseline(
			entry.baseline,
			entry.aggregate,
		);
		entry.changes = derivePersistenceChanges(entry.baseline, entry.aggregate);
		return true;
	}

	/** Restores the pre-registration state when commit enrollment rejects. */
	private rollbackIntentRegistration(entry: TrackedAggregate<Evt>): void {
		const index = this._registeredWrites.lastIndexOf(entry);
		if (index >= 0) this._registeredWrites.splice(index, 1);
		delete entry.intent;
		delete entry.registeredVersion;
		delete entry.registeredEvents;
		delete entry.registeredBaseline;
		delete entry.changes;
	}

	private assertUnchangedAfterRegistration(entry: TrackedAggregate<Evt>): void {
		const currentEvents = entry.aggregate.pendingEvents;
		const registeredEvents = entry.registeredEvents ?? [];
		const persistenceChanged = entry.registeredBaseline
			? !derivePersistenceChanges(entry.registeredBaseline, entry.aggregate)
					.empty
			: false;
		const sameEvents =
			currentEvents.length === registeredEvents.length &&
			currentEvents.every((event, index) => event === registeredEvents[index]);
		if (
			entry.registeredVersion !== entry.aggregate.version ||
			!sameEvents ||
			persistenceChanged
		) {
			throw new AggregateTrackingError(
				String(entry.aggregate.id),
				"commit",
				"mutated_after_registration",
				entry.intent,
			);
		}
	}

	private registerSavedCommit(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
		expectedVersion: Version | undefined,
	): AggregateCommitToken<Evt> {
		this.assertOpen("repository.add/update");
		// Two gates, one invariant: the instance set catches the same
		// reference; the identity-map tombstone (keyed on the instance's
		// concrete class) catches a DIFFERENT instance with the same
		// type+id: e.g. one re-created via the static factory after the
		// delete. Both mean "deleted is final within this operation".
		if (
			this._deleted.has(aggregate) ||
			this._identityMap.isDeleted(definition.aggregate, aggregate.id)
		) {
			throw new AggregateDeletedError(String(aggregate.id));
		}
		const token = this.commitEnrollment.enrollSaved(aggregate, {
			expectedVersion,
		});
		this._enrolled.add(aggregate);
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
		this._deleted.add(aggregate);
		// One call does ALL the deletion bookkeeping: the identity-map
		// entry is removed and tombstoned automatically (keyed on the
		// instance's concrete class), so repositories do not need a
		// second manual identityMap.delete() call; a forgotten leg of a
		// two-call protocol would silently weaken the deletion gate.
		// Assumption (documented on IdentityMap): repositories key the
		// map with the same concrete class their factories produce.
		this._identityMap.delete(definition.aggregate, aggregate.id);
		// Deleted aggregates stay in the harvest set: their recorded
		// deletion events must reach the outbox (repository.md, hard-
		// delete with event harvest). withCommit receives them in the
		// deleted token disposition, so the saved-only application observer
		// never fires for a deletion.
		this._enrolled.add(aggregate);
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
			if (entry.intent !== undefined) {
				this.assertUnchangedAfterRegistration(entry);
				continue;
			}
			const persistenceChanged = !derivePersistenceChanges(
				entry.baseline,
				entry.aggregate,
			).empty;
			if (
				entry.lifecycle === "loaded" &&
				(entry.aggregate.version !== entry.expectedVersion ||
					persistenceChanged)
			) {
				throw new UnenrolledChangesError(String(entry.aggregate.id));
			}
		}

		for (const instance of this._identityMap.instancesWithNewPendingEvents()) {
			if (
				this._enrolled.has(instance as IAggregateRoot<Id<string>, Evt>) ||
				this._deleted.has(instance as IAggregateRoot<Id<string>, Evt>)
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
			const changes = entry.changes;
			const events = entry.registeredEvents;
			const version = entry.registeredVersion;
			if (!changes || !events || version === undefined) {
				throw new AggregateTrackingError(
					String(entry.aggregate.id),
					"commit",
					"mutated_after_registration",
					entry.intent,
				);
			}
			const write = Object.freeze({
				intent: entry.intent,
				aggregateId: entry.aggregate.id,
				expectedVersion: entry.expectedVersion,
				version,
				changes,
				events,
			}) as AggregatePersistenceWrite<IAggregateRoot<Id<string>, Evt>, unknown>;
			await entry.definition.flush(transaction, write);
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
	}

	public assertOpen(operation: string): void {
		if (this._closed) {
			throw new TransactionClosedError(operation);
		}
	}
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
	},
): unknown {
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
 * Walks `error`'s standard `cause` chain looking for `target` by
 * reference. Bounded and cycle-safe, and hardened for arbitrary driver
 * errors: a `target` of `undefined`/`null` never matches (every error
 * without a `cause` property would otherwise "contain" a thrown
 * `undefined`), and a throwing `cause` getter (lazy deserialization,
 * revoked Proxy) is treated as no-match instead of replacing the real
 * failure with the getter's exception.
 */
/**
 * Walks `error`'s `cause` chain and returns the first `EventHarvestError`,
 * or `undefined`. Cycle-safe and getter-throw-safe, like
 * {@link causeChainContains}. `withCommit` throws the harvest-guard error
 * INSIDE `scope.transactional`, so a wrapping scope can nest it; matching
 * only the top-level error would let the wrapper mask the non-retryable
 * type. `withCommit` and `run()` share this module, so the local
 * `instanceof` is reliable for the un-wrapped link.
 */
function findHarvestErrorInChain(
	error: unknown,
): EventHarvestError | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (
		current !== null &&
		typeof current === "object" &&
		!seen.has(current)
	) {
		seen.add(current);
		if (current instanceof EventHarvestError) {
			return current;
		}
		let next: unknown;
		try {
			next = (current as { cause?: unknown }).cause;
		} catch {
			return undefined;
		}
		current = next;
	}
	return undefined;
}

function causeChainContains(error: unknown, target: unknown): boolean {
	if (target === undefined || target === null) {
		return false;
	}
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (
		current !== null &&
		typeof current === "object" &&
		!seen.has(current)
	) {
		seen.add(current);
		let next: unknown;
		try {
			next = (current as { cause?: unknown }).cause;
		} catch {
			return false;
		}
		if (next === target) {
			return true;
		}
		current = next;
	}
	return false;
}
