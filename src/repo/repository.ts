import type { Id } from "../core/id";
import type { Aggregate, DomainEvent } from "../entity/aggregate";
import type { ISpecification } from "./spec";

/**
 * The Repository works only with Aggregates.
 * It encapsulates the complexity of the data source (DB, API, etc.).
 */
export interface IRepository<
	TState,
	TEvent extends DomainEvent<string, unknown>,
	TAgg extends Aggregate<TState, TEvent>,
	TId extends Id<string>,
> {
	getById(id: TId): Promise<TAgg | null>;

	findOne(spec: ISpecification<TAgg>): Promise<TAgg | null>;

	find(spec: ISpecification<TAgg>): Promise<TAgg[]>;

	save(aggregate: TAgg): Promise<void>;

	delete(id: TId): Promise<void>;
}
