/**
 * Abstract base for all domain-layer exceptions in ddd-kit.
 *
 * Domain methods throw `DomainError`-derived exceptions when invariants are
 * violated. Consumers derive their own concrete errors from this base
 * (e.g. `OrderAlreadyShippedError extends DomainError`) so that domain
 * failures have sprechende names and can be caught via `instanceof`.
 *
 * The library itself uses this base only for its own internal errors
 * (`MissingHandlerError`, `AggregateNotFoundError`) — everything else
 * is consumer territory.
 */
export abstract class DomainError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

/**
 * Thrown by `EventSourcedAggregate.apply()` when no handler is registered
 * for the given event type. Indicates a missing entry in the aggregate's
 * `handlers` map — a programming error in the aggregate definition.
 */
export class MissingHandlerError extends DomainError {
	constructor(public readonly eventType: string) {
		super(`Missing handler for event type: ${eventType}`);
	}
}

/**
 * Thrown by `IRepository.getByIdOrFail()` when an aggregate with the given
 * id does not exist. Use the nullable variant `getById()` if "not found"
 * is an expected outcome.
 */
export class AggregateNotFoundError extends DomainError {
	constructor(
		public readonly aggregateType: string,
		public readonly id: string,
	) {
		super(`Aggregate not found: ${aggregateType}(${id})`);
	}
}
