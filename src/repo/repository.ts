import type { Id } from "../core/id";
import type {
	Aggregate,
	AggregateRoot,
	DomainEvent,
} from "../aggregate/aggregate";
import type { ISpecification } from "./spec";

/**
 * Repository interface for Aggregate Roots (Entities).
 * 
 * Repositories work exclusively with Aggregate Root Entities. The Aggregate Root
 * is the Entity that represents the aggregate externally and is the only object
 * that can be loaded/saved through repositories.
 * 
 * When loading an Aggregate Root, all child entities and value objects within
 * the aggregate state are loaded as well. When saving, the entire aggregate
 * (including all child entities) is persisted as a unit.
 * 
 * Child entities cannot be loaded or saved independently - they exist only
 * within the aggregate boundary and are managed through the Aggregate Root.
 *
 * @template TState - The type of the aggregate state (contains child entities and value objects)
 * @template TEvent - The union type of all domain events
 * @template TAgg - The aggregate root type (must be an Aggregate Root Entity)
 * @template TId - The type of the aggregate root identifier
 */
export interface IRepository<
	TState,
	TEvent extends DomainEvent<string, unknown>,
	TAgg extends AggregateRoot<TId> & Aggregate<TState, TEvent>,
	TId extends Id<string>,
> {
	getById(id: TId): Promise<TAgg | null>;

	findOne(spec: ISpecification<TAgg>): Promise<TAgg | null>;

	find(spec: ISpecification<TAgg>): Promise<TAgg[]>;

	save(aggregate: TAgg): Promise<void>;

	delete(id: TId): Promise<void>;
}
