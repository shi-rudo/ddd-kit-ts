import { BaseError } from "@shirudo/base-error";

/**
 * Abstract base for **domain-invariant violations**. Domain methods
 * (aggregates, entity validation hooks, value-object constructors)
 * throw `DomainError`-derived exceptions when a business rule is
 * violated. Consumers derive their own concrete errors — e.g.
 * `class OrderAlreadyShippedError extends DomainError<"OrderAlreadyShippedError"> {}` —
 * for `instanceof`-style catching at the App-Service boundary, where
 * they typically map to HTTP 400 / business-rule responses.
 *
 * The library itself does **not** ship any concrete `DomainError`
 * subclass — the kit can't know your invariants.
 *
 * Extends `BaseError<Name>`; see `@shirudo/base-error` for the inherited
 * surface (timestamps, cause chains, `toJSON()`, `getUserMessage()`,
 * `isRetryable`, …).
 */
export abstract class DomainError<
	Name extends string = string,
> extends BaseError<Name> {}

/**
 * Abstract base for **infrastructure / persistence failures** that the
 * App-Service can recover from — typically by retrying, by returning
 * HTTP 404 / 409, or by surfacing a "please try again" UX. These are
 * not domain-invariant violations (the business rules were not
 * broken); they describe race conditions and missing rows at the
 * storage boundary.
 *
 * Library-internal concrete subclasses: {@link AggregateNotFoundError},
 * {@link ConcurrencyConflictError}.
 */
export abstract class InfrastructureError<
	Name extends string = string,
> extends BaseError<Name> {}

/**
 * Thrown by `EventSourcedAggregate.apply()` when no handler is
 * registered for the event's type. This means the aggregate's subclass
 * forgot to add an entry to its `handlers` map — a programming /
 * configuration bug, not a domain or infrastructure failure.
 *
 * Deliberately **not** on `DomainError` or `InfrastructureError` —
 * a generic `catch (e instanceof DomainError)` handler at the App
 * layer must not mask a forgotten handler; this should crash loud and
 * fail the calling Use Case so the bug surfaces in development. The
 * replay methods (`loadFromHistory`, `restoreFromSnapshotWithEvents`)
 * also let it propagate uncaught instead of wrapping it in `Result.Err`.
 *
 * Use `isBaseError(e)` from `@shirudo/base-error` to detect
 * "any structured error from the kit or any other BaseError-using
 * library" at the App boundary.
 */
export class MissingHandlerError extends BaseError<"MissingHandlerError"> {
	constructor(
		public readonly eventType: string,
		cause?: unknown,
	) {
		super(`Missing handler for event type: ${eventType}`, cause);
	}
}

/**
 * Thrown by `IRepository.getByIdOrFail()` when an aggregate with the
 * given id does not exist. `InfrastructureError` because the storage
 * boundary, not a business rule, decided the row is absent. Use the
 * nullable variant `getById()` if "not found" is a valid outcome.
 *
 * Accepts an optional `cause` so a `Repository.save()` implementation
 * can wrap a lower-level "row not found" / driver-level error without
 * losing context. Cause-chain helpers (`getRootCause`,
 * `findInCauseChain`) from `@shirudo/base-error` traverse the chain.
 *
 * Not retryable — retrying won't make the row appear.
 */
export class AggregateNotFoundError extends InfrastructureError<"AggregateNotFoundError"> {
	constructor(
		public readonly aggregateType: string,
		public readonly id: string,
		cause?: unknown,
	) {
		super(`Aggregate not found: ${aggregateType}(${id})`, cause);
		this.withUserMessage(
			`The requested ${aggregateType} could not be found.`,
		);
	}
}

/**
 * Thrown by `IRepository.save()` when the aggregate's expected version
 * does not match the version currently persisted — i.e. another writer
 * updated the aggregate concurrently. The canonical optimistic-
 * concurrency signal; the App-Service typically reloads, re-applies
 * the use case, and retries, or surfaces HTTP 409 to the caller.
 *
 * `InfrastructureError` because the persistence layer (not a domain
 * rule) detects the race. Marks itself as `retryable: true` so the
 * `isRetryable` predicate from `@shirudo/base-error` picks it up.
 */
export class ConcurrencyConflictError extends InfrastructureError<"ConcurrencyConflictError"> {
	/**
	 * Marks this error as retryable so `isRetryable(err)` returns
	 * true. The canonical OCC pattern is to reload the aggregate, re-apply
	 * the use case, and retry on this exception.
	 */
	readonly retryable = true as const;

	constructor(
		public readonly aggregateType: string,
		public readonly aggregateId: string,
		public readonly expectedVersion: number,
		public readonly actualVersion: number,
		cause?: unknown,
	) {
		super(
			`Concurrency conflict on ${aggregateType}(${aggregateId}): expected version ${expectedVersion}, actual ${actualVersion}`,
			cause,
		);
		this.withUserMessage(
			"This resource was updated by another request. Please reload and try again.",
		);
	}
}
