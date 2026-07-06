// Main entry point (`@shirudo/ddd-kit`). Every export is named
// deliberately: the SemVer surface is exactly this list, internals never
// leak by accident, and `src/api-surface.test.ts` pins the runtime part.
// Result types come from the peer dependency `@shirudo/result`;
// `ValidationError` comes from `@shirudo/base-error`; RFC 9457 Problem
// Details presenters live in the opt-in `@shirudo/ddd-kit/http` entry;
// the repository contract suites live in `@shirudo/ddd-kit/testing`.

// Aggregates: type hub + domain events
export {
	type AggregateSnapshot,
	type IAggregateRoot,
	type IEventSourcedAggregate,
	sameVersion,
	type Version,
} from "./aggregate/aggregate";
export {
	type AggregateConfig,
	AggregateRoot,
} from "./aggregate/aggregate-root";
export {
	type AnyDomainEvent,
	type ClockFactory,
	type CreateDomainEventOptions,
	copyMetadata,
	createDomainEvent,
	type DomainEvent,
	type EventIdFactory,
	type EventMetadata,
	mergeMetadata,
	resetClockFactory,
	resetEventIdFactory,
	setClockFactory,
	setEventIdFactory,
	withClockFactory,
	withEventIdFactory,
} from "./aggregate/domain-event";
export { EventSourcedAggregate } from "./aggregate/event-sourced-aggregate";

// CQRS: commands, queries, buses
export type { Command, CommandHandler } from "./app/command";
export {
	CommandBus,
	type CommandBusOptions,
	type ICommandBus,
} from "./app/command-bus";
// App orchestration: withCommit + Unit of Work
export { withCommit } from "./app/handler";
export type { Query, QueryHandler } from "./app/query";
export {
	type IQueryBus,
	QueryBus,
	type QueryBusOptions,
} from "./app/query-bus";
export {
	CommitError,
	NestedUnitOfWorkError,
	type RepositoryFactories,
	RollbackError,
	type RunOptions,
	TransactionClosedError,
	UnitOfWork,
	type UnitOfWorkContext,
	type UnitOfWorkDeps,
	type UnitOfWorkSession,
} from "./app/unit-of-work";

// Core: errors + branded ids
export {
	AggregateDeletedError,
	AggregateNotFoundError,
	type AggregateNotFoundErrorOptions,
	ConcurrencyConflictError,
	type ConcurrencyConflictErrorOptions,
	DomainError,
	DuplicateAggregateError,
	type DuplicateAggregateErrorOptions,
	DuplicateHandlerRegistrationError,
	type DuplicateHandlerRegistrationErrorOptions,
	ErrorMapperFailedError,
	type ErrorMapperFailedErrorOptions,
	EventHarvestError,
	HostileStateKeyError,
	InfrastructureError,
	type KitErrorCode,
	type KitErrorOptions,
	MissingHandlerError,
	SnapshotSchemaMismatchError,
	type SnapshotSchemaMismatchErrorOptions,
	UnenrolledChangesError,
	UnregisteredHandlerError,
	type UnregisteredHandlerErrorOptions,
	UnreplayableAggregateError,
} from "./core/errors";
export type { Id, IdGenerator } from "./core/id";

// Domain State Machine
export {
	analyzeDomainMachineDefinition,
	canTransitionDomainState,
	createInitialDomainMachineSnapshot,
	type DomainMachineDefinition,
	type DomainMachineDefinitionAnalysis,
	type DomainMachineDefinitionDiagnostic,
	type DomainMachineInput,
	type DomainMachineReadonly,
	type DomainMachineSnapshot,
	type DomainMachineTransitionDescription,
	DomainStateMachine,
	type DomainStateNode,
	type DomainTransition,
	DomainTransitionGuardRejectedError,
	type DomainTransitionGuardResult,
	type DomainTransitionOutcome,
	type DomainTransitionResult,
	InvalidDomainMachineContextError,
	InvalidDomainMachineDefinitionError,
	InvalidDomainMachineInputError,
	InvalidDomainMachineSnapshotError,
	InvalidDomainTransitionError,
	InvalidDomainTransitionGuardResultError,
	InvalidDomainTransitionResultError,
	type PreparedDomainMachineDefinition,
	prepareDomainMachineDefinition,
	ReentrantDomainStateMachineEvaluationError,
	transitionDomainState,
} from "./domain-state-machine/domain-state-machine";

// Entities
export {
	Entity,
	type EntityConfig,
	entityIds,
	findEntityById,
	freezeShallow,
	hasEntityId,
	type Identifiable,
	type IEntity,
	removeEntityById,
	replaceEntityById,
	sameEntity,
	updateEntityById,
} from "./entity/entity";

// Events: bus, outbox, ports
export { EventBusImpl } from "./events/event-bus";
export { InMemoryOutbox, type InMemoryOutboxOptions } from "./events/outbox";
export type {
	DeadLetterRecord,
	DispatchTrackingOutbox,
	EventBus,
	EventHandler,
	OnceOptions,
	Outbox,
	OutboxRecord,
} from "./events/ports";

// Repository: ports, identity map, event store, scopes
export type {
	EventStore,
	EventStoreAppendOptions,
	ReadStreamOptions,
} from "./repo/event-store";
export { type AggregateClass, IdentityMap } from "./repo/identity-map";
export { InMemoryEventStore } from "./repo/in-memory-event-store";
export type {
	IQueryableRepository,
	IRepository,
	IUnitOfWorkRepository,
} from "./repo/repository";
// computeBackoffDelay is deliberately NOT exported: internal since 2.x
// (unit-tested via direct source import), removed from the surface in v3.
export {
	RetryingTransactionScope,
	type RetryPolicy,
} from "./repo/retrying-scope";
export type {
	TransactionalOptions,
	TransactionScope,
} from "./repo/scope";

// Utils (deep equality; also available via `@shirudo/ddd-kit/utils`)
export {
	type DeepEqualExceptOptions,
	type DeepOmitKey,
	type DeepOmitOptions,
	type DeepOmitPathSegment,
	deepEqual,
	deepEqualExcept,
	deepOmit,
} from "./utils";

// Validation
export { voValidated } from "./validation";

// Value Objects
export {
	deepFreeze,
	type IValueObject,
	ValueObject,
	type VO,
	vo,
	voEquals,
	voEqualsExcept,
	voWithValidation,
} from "./value-object/value-object";
