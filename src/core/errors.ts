/**
 * Common marker base for every error the library itself raises. An
 * App-Service can write `catch (e) { if (e instanceof KitError) ... }`
 * to handle anything the kit might surface as a recoverable / expected
 * failure; an unrelated `TypeError` or `ReferenceError` falls through
 * to the catch-all "HTTP 500 / unexpected bug" branch.
 *
 * Two concrete subtrees:
 *  - {@link DomainError} — invariant violations (consumer-derived).
 *  - {@link InfrastructureError} — persistence / concurrency.
 *
 * One stand-alone:
 *  - {@link MissingHandlerError} — programming/configuration bug. Lives
 *    on `KitError` but explicitly NOT on `DomainError`, so a generic
 *    domain-error handler can't mask a forgotten event handler.
 */
export abstract class KitError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/**
 * Abstract base for **domain-invariant violations**. Domain methods
 * (aggregates, entity validation hooks, value-object constructors)
 * throw `DomainError`-derived exceptions when a business rule is
 * violated. Consumers derive their own concrete errors — e.g.
 * `class OrderAlreadyShippedError extends DomainError {}` — for
 * `instanceof`-style catching at the App-Service boundary, where they
 * typically map to HTTP 400 / business-rule responses.
 *
 * The library itself does **not** ship any concrete `DomainError`
 * subclass — the kit can't know your invariants. `MissingHandlerError`,
 * `AggregateNotFoundError`, and `ConcurrencyConflictError` deliberately
 * sit on other branches of the hierarchy (see below) because they are
 * not invariant violations.
 */
export abstract class DomainError extends KitError {}

/**
 * Abstract base for **infrastructure / persistence failures** that the
 * App-Service can recover from — typically by retrying, by returning
 * HTTP 404 / 409, or by surfacing a "please try again" UX. These are
 * not domain-invariant violations (the business rules were not
 * broken); they describe race conditions and missing rows at the
 * storage boundary.
 *
 * Library-internal concrete subclasses:
 *  - {@link AggregateNotFoundError}
 *  - {@link ConcurrencyConflictError}
 */
export abstract class InfrastructureError extends KitError {}

/**
 * Thrown by `EventSourcedAggregate.apply()` when no handler is
 * registered for the event's type. This means the aggregate's subclass
 * forgot to add an entry to its `handlers` map — a programming /
 * configuration bug, not a domain or infrastructure failure.
 *
 * Lives on `KitError` (catchable as "an expected library error") but
 * deliberately **not** on `DomainError` or `InfrastructureError` — a
 * generic `catch (e instanceof DomainError)` handler at the App layer
 * must not mask a forgotten handler; this should crash loud and fail
 * the calling Use Case so the bug surfaces in development. The replay
 * methods (`loadFromHistory`, `restoreFromSnapshotWithEvents`) also let
 * it propagate instead of catching it.
 */
export class MissingHandlerError extends KitError {
	constructor(public readonly eventType: string) {
		super(`Missing handler for event type: ${eventType}`);
	}
}

/**
 * Thrown by `IRepository.getByIdOrFail()` when an aggregate with the
 * given id does not exist. `InfrastructureError` because the storage
 * boundary, not a business rule, decided the row is absent. Use the
 * nullable variant `getById()` if "not found" is a valid outcome.
 */
export class AggregateNotFoundError extends InfrastructureError {
	constructor(
		public readonly aggregateType: string,
		public readonly id: string,
	) {
		super(`Aggregate not found: ${aggregateType}(${id})`);
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
 * rule) detects the race.
 */
export class ConcurrencyConflictError extends InfrastructureError {
	constructor(
		public readonly aggregateType: string,
		public readonly aggregateId: string,
		public readonly expectedVersion: number,
		public readonly actualVersion: number,
	) {
		super(
			`Concurrency conflict on ${aggregateType}(${aggregateId}): expected version ${expectedVersion}, actual ${actualVersion}`,
		);
	}
}
