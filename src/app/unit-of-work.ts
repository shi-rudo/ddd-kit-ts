import {
	AggregateDeletedError,
	EventHarvestError,
	type InfrastructureError,
} from "../core/errors";
import type { IAggregateRoot, Version } from "../domain/aggregate/aggregate";
import type { AnyDomainEvent } from "../domain/event/domain-event";
import type { Id } from "../domain/identity/id";
import type { EventBus, OutboxWriter } from "../events/ports";
import type { AggregateClass } from "../repo/identity-map";
import type { PersistenceModel } from "../repo/persistence-model";
import type { TransactionScope } from "../repo/scope";
import { abortReason } from "../utils/abort";
import type { ExecutionContext } from "../utils/execution";
import {
	CommitError,
	InvalidRepositoryDefinitionError,
	NestedUnitOfWorkError,
	RollbackError,
	TransactionClosedError,
} from "./errors";
import { withCommit } from "./handler";
import type {
	AggregatePersistenceWrite,
	RepositoryTracking,
	RuntimePersistenceDefinition,
} from "./persistence-contract";
import { bindRepositoryWrites } from "./repository-facade";
import { Session } from "./unit-of-work-session";

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
type RepositoryFacadeOf<TDefinition> =
	TDefinition extends RepositoryDefinition<
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
