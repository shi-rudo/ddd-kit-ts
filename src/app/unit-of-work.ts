import type { IAggregateRoot, Version } from "../aggregate/aggregate";
import type { AnyDomainEvent } from "../aggregate/domain-event";
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

/**
 * Thrown when the unit-of-work context is used after `run()` has
 * settled: reading `context.repositories` / `context.transaction`, or
 * calling `session.enrollSaved` / `session.enrollDeleted`, once the
 * transaction has committed or rolled back.
 *
 * Use-after-close is a programming bug (typically a leaked context
 * reference or a fire-and-forget promise outliving the callback), so
 * this carries the `WIRING` category and should crash loud.
 *
 * **Honest scope of this guard:** the kit can only invalidate what it
 * controls - the context getters and the session. A repository or raw
 * transaction handle captured into a variable BEFORE close keeps
 * working as far as the kit can see; whether the underlying tx handle
 * rejects is ORM-specific. Do not let references escape the callback.
 */
export class TransactionClosedError extends KitWiringError<"TRANSACTION_CLOSED"> {
	constructor(public readonly operation: string) {
		super(
			"TRANSACTION_CLOSED",
			`Unit of work is closed: ${operation} was called after the ` +
				"transaction committed or rolled back. Do not use the context or " +
				"session outside the run() callback.",
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

/**
 * The enrollment handle a unit of work hands to its repositories.
 *
 * Repositories enroll every aggregate they write so the unit of work
 * can harvest pending events into the outbox (inside the transaction)
 * and acknowledge them after the commit through the same internal lifecycle
 * `withCommit` runs for its opaque commit tokens. The session retains
 * tokens returned by repository enrollment, so "forgot to list the
 * aggregate" cannot happen per use-case call site; each repository
 * implements enrollment once and its tests pin it once.
 *
 * Contract for repository implementations:
 * - `findById(id)` checks `identityMap.get` BEFORE hydrating, treats
 *   `identityMap.isDeleted` as not-found (`null`), and registers the
 *   hydrated instance after - two loads of the same aggregate in one
 *   unit of work must return the same instance.
 * - `save(aggregate)` calls {@link enrollSaved} BEFORE the row write:
 *   the deleted-gate then throws `AggregateDeletedError` before any SQL
 *   runs (instead of the write surfacing as a confusing
 *   `ConcurrencyConflictError` against the deleted row). Enrollment is
 *   idempotent per instance, mirroring `withCommit`'s token dedupe,
 *   and a failed write rolls the whole unit of work back anyway.
 * - `delete(aggregate)` calls {@link enrollDeleted} - ONE call does all
 *   the deletion bookkeeping: the identity-map entry is removed and
 *   tombstoned automatically (keyed on the instance's concrete class),
 *   the recorded deletion events are still harvested into the outbox,
 *   and saving or re-registering the aggregate (same instance OR a
 *   re-created one with the same type+id) later in this unit of work
 *   throws `AggregateDeletedError`.
 *
 * The use case can also enroll manually via `context.session` for the
 * rare write that bypasses a repository.
 */
export interface UnitOfWorkSession<Evt extends AnyDomainEvent = AnyDomainEvent>
	extends CommitEnrollment<Evt> {
	/**
	 * The per-operation Identity Map (Fowler): one aggregate type+id,
	 * one in-memory instance. Created fresh per `run()`, cleared on
	 * close; accessing it after close throws
	 * {@link TransactionClosedError}.
	 */
	readonly identityMap: IdentityMap;

	/** Enroll an aggregate that was (or will be) written in this unit of work. */
	enrollSaved(
		aggregate: IAggregateRoot<Id<string>, Evt>,
	): AggregateCommitToken<Evt>;

	/**
	 * Enroll an aggregate whose row was (or will be) deleted in this
	 * unit of work. Its pending events (e.g. a recorded deletion event)
	 * are harvested like any other; re-saving the instance afterwards
	 * throws `AggregateDeletedError`.
	 */
	enrollDeleted(
		aggregate: IAggregateRoot<Id<string>, Evt>,
	): AggregateCommitToken<Evt>;
}

/**
 * What the work callback receives: repositories already bound to the
 * live transaction, the enrollment session, and, deliberately named to
 * look like the escape hatch it is, the raw transaction handle.
 *
 * All members throw {@link TransactionClosedError} once `run()` has
 * settled; do not let the context escape the callback.
 */
export interface UnitOfWorkContext<
	TCtx,
	TRepos,
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	readonly repositories: TRepos;

	/**
	 * **Escape hatch: you are leaving the unit of work's guarantees.**
	 * A write issued on the raw handle bypasses the repository contract,
	 * enrollment (its aggregate's events are NOT harvested unless you
	 * also call `session.enrollSaved`), and the identity map (a later
	 * `findById` of the same aggregate hydrates a SECOND instance:
	 * double harvest, double acknowledgement). Use it only for writes no
	 * repository covers, pair it with manual enrollment, and prefer
	 * adding a repository method whenever one could exist.
	 */
	readonly rawTransaction: TCtx;

	readonly session: UnitOfWorkSession<Evt>;

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

/**
 * Per-repository factory map: for each key of `TRepos`, a function
 * that constructs the repository bound to the live transaction handle
 * and the enrollment session. Called once per `run()`, so every
 * repository of one unit of work shares the same transaction.
 *
 * ```ts
 * const factories = {
 *   orders: (tx, session) => new DrizzleOrderRepository(tx, session),
 *   invoices: (tx, session) => new DrizzleInvoiceRepository(tx, session),
 * };
 * ```
 */
export type RepositoryFactories<
	TCtx,
	TRepos,
	Evt extends AnyDomainEvent = AnyDomainEvent,
> = {
	[K in keyof TRepos]: (tx: TCtx, session: UnitOfWorkSession<Evt>) => TRepos[K];
};

/** Dependencies for {@link UnitOfWork}; the app-level singleton part. */
export interface UnitOfWorkDeps<Evt extends AnyDomainEvent, TCtx, TRepos> {
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
	repositories: RepositoryFactories<TCtx, TRepos, Evt>;
}

/**
 * Explicit-save Unit of Work: one `run()` call is one application-level
 * write operation. All repository writes inside the callback share one
 * transaction and either persist completely or not at all.
 *
 * Built ON TOP of `withCommit` - the commit orchestration (event
 * harvest into the outbox inside the transaction, internal acknowledgement
 * after the commit, best-effort in-process publish last) is inherited,
 * not reimplemented. What this layer adds:
 *
 * - **Tx-bound repositories via a registry.** The callback receives
 *   ready-made repositories instead of a raw transaction handle; the
 *   factory map is wired once at construction.
 * - **Repository-owned enrollment.** Repositories enroll what they write via
 *   {@link UnitOfWorkSession}; the session retains the invocation-scoped
 *   commit tokens, so the use case cannot forget to return one.
 * - **Lifecycle errors.** {@link NestedUnitOfWorkError},
 *   {@link TransactionClosedError}, {@link CommitError},
 *   {@link RollbackError}, {@link AggregateDeletedError}.
 *
 * - **A per-operation Identity Map** on the session: repositories
 *   check it before hydrating and register after, so one type+id maps
 *   to one in-memory instance per unit of work (the contract that makes
 *   reference-keyed commit-token enrollment sound, now shipped instead
 *   of merely documented).
 *
 * What it deliberately does NOT do (v1): no auto-flush (explicit
 * `save()` only - `hasChanges` makes a redundant save a cheap no-op),
 * no savepoints, no nested-transaction joining. `withCommit` with
 * hand-rolled repos remains fully supported; this facade is opt-in.
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
 *     restaurants: (tx, session) => new DrizzleRestaurantRepository(tx, session),
 *   },
 * };
 *
 * const uow = new UnitOfWork(deps);
 * const result = await uow.run(async ({ repositories }) => {
 *   const restaurant = await repositories.restaurants.getById(id);
 *   restaurant.changeOpeningHours(openingHours);
 *   await repositories.restaurants.save(restaurant); // save() enrolls
 *   return restaurant.id;
 * });
 * ```
 */
export class UnitOfWork<
	Evt extends AnyDomainEvent,
	TCtx,
	TRepos extends Record<string, unknown>,
> {
	private _active = false;

	constructor(private readonly deps: UnitOfWorkDeps<Evt, TCtx, TRepos>) {}

	/**
	 * Execute one unit of work: open the transaction, hand the callback
	 * tx-bound repositories, commit on resolve, roll back on throw,
	 * run the post-commit lifecycle (acknowledge, observe, publish) for every
	 * enrolled aggregate. Returns the callback's result.
	 */
	public async run<R>(
		work: (context: UnitOfWorkContext<TCtx, TRepos, Evt>) => Promise<R>,
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
					const context = makeContext(repositories, tx, s, options?.signal);
					try {
						const result = await work(context);
						// Catch a forgotten enrollment before sealing: a loaded
						// aggregate with pending events that was never enrolled
						// would otherwise drop its events silently. Throws inside
						// the transaction, so the unit of work rolls back.
						s.assertAllChangesEnrolled();
						workCompleted = true;
						// Seal immediately: the aggregates snapshot below is what
						// gets harvested. A late enrollment (an un-awaited
						// repo.save() promise still in flight) must throw
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

	private buildRepositories(tx: TCtx, session: UnitOfWorkSession<Evt>): TRepos {
		const repositories = {} as TRepos;
		for (const key of Object.keys(this.deps.repositories) as Array<
			keyof TRepos
		>) {
			repositories[key] = this.deps.repositories[key](tx, session);
		}
		return repositories;
	}
}

/** Internal session implementation; closed by `run()`'s finally. */
class Session<Evt extends AnyDomainEvent> implements UnitOfWorkSession<Evt> {
	// Insertion-ordered: harvest order = enrollment order (withCommit
	// then preserves per-aggregate emission order).
	private readonly _enrolled = new Set<IAggregateRoot<Id<string>, Evt>>();
	private readonly _deleted = new Set<IAggregateRoot<Id<string>, Evt>>();
	private readonly _commitTokens = new Set<AggregateCommitToken<Evt>>();
	private readonly _identityMap = new IdentityMap();
	private _closed = false;

	constructor(private readonly commitEnrollment: CommitEnrollment<Evt>) {}

	public get identityMap(): IdentityMap {
		this.assertOpen("session.identityMap");
		return this._identityMap;
	}

	public enrollSaved(
		aggregate: IAggregateRoot<Id<string>, Evt>,
	): AggregateCommitToken<Evt> {
		this.assertOpen("session.enrollSaved");
		// Two gates, one invariant: the instance set catches the same
		// reference; the identity-map tombstone (keyed on the instance's
		// concrete class) catches a DIFFERENT instance with the same
		// type+id: e.g. one re-created via the static factory after the
		// delete. Both mean "deleted is final within this operation".
		if (
			this._deleted.has(aggregate) ||
			this._identityMap.isDeleted(
				aggregate.constructor as AggregateClass<unknown>,
				aggregate.id,
			)
		) {
			throw new AggregateDeletedError(String(aggregate.id));
		}
		this._enrolled.add(aggregate);
		const token = this.commitEnrollment.enrollSaved(aggregate);
		this._commitTokens.add(token);
		return token;
	}

	public enrollDeleted(
		aggregate: IAggregateRoot<Id<string>, Evt>,
	): AggregateCommitToken<Evt> {
		this.assertOpen("session.enrollDeleted");
		const token = this.commitEnrollment.enrollDeleted(aggregate);
		this._deleted.add(aggregate);
		// One call does ALL the deletion bookkeeping: the identity-map
		// entry is removed and tombstoned automatically (keyed on the
		// instance's concrete class), so repositories do not need a
		// second manual identityMap.delete() call; a forgotten leg of a
		// two-call protocol would silently weaken the deletion gate.
		// Assumption (documented on IdentityMap): repositories key the
		// map with the same concrete class their factories produce.
		this._identityMap.delete(
			aggregate.constructor as AggregateClass<unknown>,
			aggregate.id,
		);
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
	 * End-of-run safety net: a loaded aggregate (registered in the identity
	 * map via `findById`) that carries pending events but was never enrolled
	 * is almost certainly a forgotten `save()` / `enrollSaved`, whose events
	 * would otherwise be silently dropped. Convert that silent loss into a
	 * loud, rolling-back {@link UnenrolledChangesError}. Only sees loaded
	 * aggregates; a freshly created one that was never enrolled is invisible
	 * to the kit (the contract test suite remains the full mitigation).
	 */
	public assertAllChangesEnrolled(): void {
		for (const instance of this._identityMap.instancesWithNewPendingEvents()) {
			if (
				this._enrolled.has(instance as IAggregateRoot<Id<string>, Evt>) ||
				this._deleted.has(instance as IAggregateRoot<Id<string>, Evt>)
			) {
				continue;
			}
			// Events were recorded on a loaded aggregate after it was
			// registered, yet it was never enrolled: a forgotten save whose
			// events would be silently dropped.
			const id = (instance as { id?: unknown }).id;
			throw new UnenrolledChangesError(String(id));
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
	}

	public assertOpen(operation: string): void {
		if (this._closed) {
			throw new TransactionClosedError(operation);
		}
	}
}

function makeContext<TCtx, TRepos, Evt extends AnyDomainEvent>(
	repositories: TRepos,
	transaction: TCtx,
	session: Session<Evt>,
	signal: AbortSignal | undefined,
): UnitOfWorkContext<TCtx, TRepos, Evt> {
	return {
		get repositories(): TRepos {
			session.assertOpen("context.repositories");
			return repositories;
		},
		get rawTransaction(): TCtx {
			session.assertOpen("context.rawTransaction");
			return transaction;
		},
		session,
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
