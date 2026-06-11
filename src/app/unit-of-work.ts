import { BaseError } from "@shirudo/base-error";
import type { IAggregateRoot } from "../aggregate/aggregate";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import { InfrastructureError } from "../core/errors";
import type { Id } from "../core/id";
import type { EventBus, Outbox } from "../events/ports";
import type { TransactionScope } from "../repo/scope";
import { withCommit } from "./handler";

/**
 * Thrown when `UnitOfWork.run()` is called while the same instance is
 * already executing a unit of work: either a genuinely nested `run()`
 * inside the work callback, or two concurrent operations sharing one
 * instance.
 *
 * Both are contract violations, not recoverable infrastructure
 * failures, so this extends `BaseError` directly (same reasoning as
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
export class NestedUnitOfWorkError extends BaseError<"NestedUnitOfWorkError"> {
	constructor() {
		super(
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
 * this extends `BaseError` directly and should crash loud.
 *
 * **Honest scope of this guard:** the kit can only invalidate what it
 * controls - the context getters and the session. A repository or raw
 * transaction handle captured into a variable BEFORE close keeps
 * working as far as the kit can see; whether the underlying tx handle
 * rejects is ORM-specific. Do not let references escape the callback.
 */
export class TransactionClosedError extends BaseError<"TransactionClosedError"> {
	constructor(public readonly operation: string) {
		super(
			`Unit of work is closed: ${operation} was called after the ` +
				"transaction committed or rolled back. Do not use the context or " +
				"session outside the run() callback.",
		);
	}
}

/**
 * Thrown by `UnitOfWorkSession.enrollSaved` when the aggregate was
 * already enrolled as deleted in the same unit of work. Deletion is
 * final within an operation: saving a deleted aggregate would write a
 * row the delete just removed (or resurrect it), which is always a
 * use-case bug. Extends `BaseError` directly: crash loud.
 */
export class AggregateDeletedError extends BaseError<"AggregateDeletedError"> {
	constructor(public readonly aggregateId: string) {
		super(
			`Aggregate ${aggregateId} was enrolled as deleted in this unit of ` +
				"work and cannot be saved again. Deletion is final within an " +
				"operation; if the aggregate must live, do not delete it.",
		);
	}
}

/**
 * The unit of work failed AFTER the work callback completed
 * successfully: during the event harvest, the outbox write, or the
 * transaction commit itself. The kit cannot see inside
 * `TransactionScope.transactional`, so these three are deliberately
 * one error class - the underlying failure is attached as `cause`.
 *
 * `InfrastructureError`: the business logic ran to completion; the
 * persistence boundary failed. The transaction rolled back (or never
 * committed), no aggregate was marked persisted, and pending events
 * survive on the aggregates, so the operation is safe to retry.
 */
export class CommitError extends InfrastructureError<"CommitError"> {
	constructor(cause: unknown) {
		super(
			"Unit of work failed after the work callback completed: the event " +
				"harvest, outbox write, or transaction commit rejected. The " +
				"transaction did not commit; see cause.",
			cause,
		);
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
export class RollbackError extends InfrastructureError<"RollbackError"> {
	constructor(
		cause: unknown,
		public readonly rollbackCause: unknown,
	) {
		super(
			"The work callback failed and the transaction scope rejected with a " +
				"different error (possible rollback failure). The callback's error " +
				"is the cause; the scope's error is in rollbackCause.",
			cause,
		);
	}
}

/**
 * The enrollment handle a unit of work hands to its repositories.
 *
 * Repositories enroll every aggregate they write so the unit of work
 * can harvest pending events into the outbox (inside the transaction)
 * and call `markPersisted` after the commit - the same lifecycle
 * `withCommit` runs for its returned `aggregates` array, minus the
 * footgun: with enrollment, "forgot to list the aggregate" cannot
 * happen per call site; each repository implements it once and its
 * tests pin it once.
 *
 * Contract for repository implementations:
 * - `save(aggregate)` calls {@link enrollSaved} (after the write, or
 *   before - order inside the transaction does not matter; enrollment
 *   is idempotent per instance, mirroring `withCommit`'s reference
 *   dedupe).
 * - `delete(aggregate)` calls {@link enrollDeleted}: the aggregate's
 *   recorded deletion events are still harvested into the outbox, and
 *   saving the same instance later in this unit of work throws
 *   {@link AggregateDeletedError}.
 *
 * The use case can also enroll manually via `context.session` for the
 * rare write that bypasses a repository.
 */
export interface UnitOfWorkSession<
	Evt extends AnyDomainEvent = AnyDomainEvent,
> {
	/** Enroll an aggregate that was (or will be) written in this unit of work. */
	enrollSaved(aggregate: IAggregateRoot<Id<string>, Evt>): void;

	/**
	 * Enroll an aggregate whose row was (or will be) deleted in this
	 * unit of work. Its pending events (e.g. a recorded deletion event)
	 * are harvested like any other; re-saving the instance afterwards
	 * throws {@link AggregateDeletedError}.
	 */
	enrollDeleted(aggregate: IAggregateRoot<Id<string>, Evt>): void;
}

/**
 * What the work callback receives: repositories already bound to the
 * live transaction, the raw transaction handle (for writes no
 * repository covers), and the enrollment session.
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
	readonly transaction: TCtx;
	readonly session: UnitOfWorkSession<Evt>;
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
	[K in keyof TRepos]: (
		tx: TCtx,
		session: UnitOfWorkSession<Evt>,
	) => TRepos[K];
};

/** Dependencies for {@link UnitOfWork}; the app-level singleton part. */
export interface UnitOfWorkDeps<
	Evt extends AnyDomainEvent,
	TCtx,
	TRepos,
> {
	scope: TransactionScope<TCtx>;
	outbox: Outbox<Evt>;
	bus?: EventBus<Evt>;
	/** See `withCommit`: observer for post-commit `bus.publish` failures. */
	onPublishError?: (error: unknown, events: ReadonlyArray<Evt>) => void;
	repositories: RepositoryFactories<TCtx, TRepos, Evt>;
}

/**
 * Explicit-save Unit of Work: one `run()` call is one application-level
 * write operation. All repository writes inside the callback share one
 * transaction and either persist completely or not at all.
 *
 * Built ON TOP of `withCommit` - the commit orchestration (event
 * harvest into the outbox inside the transaction, `markPersisted`
 * after the commit, best-effort in-process publish last) is inherited,
 * not reimplemented. What this layer adds:
 *
 * - **Tx-bound repositories via a registry.** The callback receives
 *   ready-made repositories instead of a raw transaction handle; the
 *   factory map is wired once at construction.
 * - **Enrollment instead of a returned aggregates array.** Repositories
 *   enroll what they write via {@link UnitOfWorkSession}; the use case
 *   cannot forget to list an aggregate (the `withCommit` footgun).
 * - **Lifecycle errors.** {@link NestedUnitOfWorkError},
 *   {@link TransactionClosedError}, {@link CommitError},
 *   {@link RollbackError}, {@link AggregateDeletedError}.
 *
 * What it deliberately does NOT do (v1): no auto-flush (explicit
 * `save()` only - `hasChanges` makes a redundant save a cheap no-op),
 * no savepoints, no nested-transaction joining, no identity map yet
 * (planned as the next phase). `withCommit` with hand-rolled repos
 * remains fully supported; this facade is opt-in.
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
 *   const restaurant = await repositories.restaurants.getByIdOrFail(id);
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
	 * run the post-commit lifecycle (markPersisted, publish) for every
	 * enrolled aggregate. Returns the callback's result.
	 */
	public async run<R>(
		work: (context: UnitOfWorkContext<TCtx, TRepos, Evt>) => Promise<R>,
	): Promise<R> {
		if (this._active) {
			throw new NestedUnitOfWorkError();
		}
		this._active = true;

		const session = new Session<Evt>();
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
				},
				async (tx) => {
					const repositories = this.buildRepositories(tx, session);
					const context = makeContext(repositories, tx, session);
					try {
						const result = await work(context);
						workCompleted = true;
						return { result, aggregates: session.enrolledAggregates };
					} catch (error) {
						workThrew = true;
						workError = error;
						throw error;
					}
				},
			);
		} catch (error) {
			if (workThrew) {
				// The scope normally rethrows the callback's error unchanged
				// (rolled back, pass through - ConcurrencyConflictError & co.
				// stay catchable as-is). A scope that WRAPS the original is
				// detected via the cause chain and also passed through. Only
				// a rejection that neither IS nor wraps the callback's error
				// indicates the rollback itself failed.
				if (error === workError || causeChainContains(error, workError)) {
					throw error;
				}
				throw new RollbackError(workError, error);
			}
			if (workCompleted) {
				throw new CommitError(error);
			}
			// Neither flag set: withCommit rejected before the callback ran
			// (e.g. the scope failed to even open a transaction).
			throw error;
		} finally {
			session.close();
			this._active = false;
		}
	}

	private buildRepositories(
		tx: TCtx,
		session: UnitOfWorkSession<Evt>,
	): TRepos {
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
	private _closed = false;

	public enrollSaved(aggregate: IAggregateRoot<Id<string>, Evt>): void {
		this.assertOpen("session.enrollSaved");
		if (this._deleted.has(aggregate)) {
			throw new AggregateDeletedError(String(aggregate.id));
		}
		this._enrolled.add(aggregate);
	}

	public enrollDeleted(aggregate: IAggregateRoot<Id<string>, Evt>): void {
		this.assertOpen("session.enrollDeleted");
		this._deleted.add(aggregate);
		// Deleted aggregates stay in the harvest set: their recorded
		// deletion events must reach the outbox (repository.md, hard-
		// delete with event harvest). The post-commit markPersisted on a
		// discarded instance is harmless.
		this._enrolled.add(aggregate);
	}

	public get enrolledAggregates(): ReadonlyArray<
		IAggregateRoot<Id<string>, Evt>
	> {
		return [...this._enrolled];
	}

	public close(): void {
		this._closed = true;
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
): UnitOfWorkContext<TCtx, TRepos, Evt> {
	return {
		get repositories(): TRepos {
			session.assertOpen("context.repositories");
			return repositories;
		},
		get transaction(): TCtx {
			session.assertOpen("context.transaction");
			return transaction;
		},
		session,
	};
}

/**
 * Walks `error`'s standard `cause` chain looking for `target` by
 * reference. Bounded and cycle-safe: arbitrary driver errors may carry
 * arbitrary cause shapes.
 */
function causeChainContains(error: unknown, target: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (
		current !== null &&
		typeof current === "object" &&
		!seen.has(current)
	) {
		seen.add(current);
		const next: unknown = (current as { cause?: unknown }).cause;
		if (next === target) {
			return true;
		}
		current = next;
	}
	return false;
}
