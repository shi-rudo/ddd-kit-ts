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
export type { AggregateAddress } from "./aggregate/aggregate-address";
export {
	type AggregateConfig,
	AggregateRoot,
} from "./aggregate/aggregate-root";
export {
	type AnyDomainEvent,
	type AnyUncommittedDomainEvent,
	type ClockFactory,
	type CreateDomainEventFromFactsOptions,
	type CreateDomainEventOptions,
	type CreateDomainEventStampOptions,
	type CreateUncommittedDomainEventOptions,
	copyMetadata,
	createDomainEvent,
	createDomainEventFactory,
	createDomainEventFromFacts,
	createUncommittedDomainEvent,
	type DomainEvent,
	type DomainEventFactory,
	type DomainEventFactoryOptions,
	type DomainEventStamp,
	defaultDomainEventFactory,
	type EventIdFactory,
	type EventMetadata,
	mergeMetadata,
	type PendingDomainEvent,
	recordDomainEvent,
	type UncommittedDomainEvent,
	type UncommittedDomainEventOf,
} from "./aggregate/domain-event";
export {
	type DomainEventValidationCode,
	DomainEventValidationError,
	type DomainEventValidationField,
	SnapshotTimeValidationError,
} from "./aggregate/domain-event-errors";
export { EventSourcedAggregate } from "./aggregate/event-sourced-aggregate";

// CQRS: commands, queries, buses
export type { Command, CommandHandler, PublishedCommand } from "./app/command";
export {
	CommandBus,
	type CommandBusOptions,
	type ICommandBus,
} from "./app/command-bus";
export {
	type CommandCommitOriginCandidate,
	type CommandMessageContent,
	type CommandMessageRelationships,
	type CommandOutboxCommitCandidate,
	type CommandOutboxMapper,
	type CommandOutboxWriter,
	type DurableCommandMessage,
	routeEventsToCommandOutbox,
} from "./app/command-outbox";
export {
	type DomainErrorClass,
	domainErrorToResult,
} from "./app/domain-error-result";
// App orchestration: withCommit + Unit of Work
export {
	type AggregateCommitToken,
	type CommitEnrollment,
	type CommitEnrollmentOptions,
	type WithCommitDeps,
	type WithCommitWorkResult,
	withCommit,
} from "./app/handler";
export {
	type IdempotencyClaim,
	type IdempotencyClaimHandle,
	type IdempotencyLease,
	type IdempotencyOperationErrorContext,
	type IdempotencyReconciliation,
	type IdempotencyReconciliationDecision,
	type IdempotencyStore,
	type IdempotentCommitRequest,
	type IdempotentCommitResult,
	type IdempotentExecution,
	type WithIdempotentCommitDeps,
	withIdempotentCommit,
} from "./app/idempotency";
export {
	InMemoryIdempotencyStore,
	type InMemoryIdempotencyStoreOptions,
} from "./app/in-memory-idempotency-store";
export type { Query, QueryHandler } from "./app/query";
export {
	type IQueryBus,
	QueryBus,
	type QueryBusOptions,
} from "./app/query-bus";
export {
	type DomainEventStampFactory,
	type DomainEventStampProvider,
	recordPendingEvents,
} from "./app/record-pending-events";
export {
	AggregateTrackingError,
	type AggregateTrackingFailure,
	type AggregateWriteIntent,
	CommitError,
	InvalidRepositoryAdapterError,
	InvalidRepositoryDefinitionError,
	NestedUnitOfWorkError,
	RepositoryErrorMappingFailedError,
	RollbackError,
	TransactionClosedError,
} from "./app/errors";
export {
	type AggregatePersistenceWrite,
	type AggregateWriteRegistration,
	type CompatibleRepositoryDefinitions,
	defineRepository,
	type PhysicalRemovalRegistration,
	type RepositoriesOf,
	type RepositoryDefinition,
	type RepositoryDefinitionOptions,
	type RepositoryTracking,
	type RunOptions,
	UnitOfWork,
	type UnitOfWorkContext,
	type UnitOfWorkDeps,
	type UnitOfWorkIdentityMap,
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
	DuplicateEventIdError,
	DuplicateHandlerRegistrationError,
	type DuplicateHandlerRegistrationErrorOptions,
	ErrorMapperFailedError,
	type ErrorMapperFailedErrorOptions,
	EventHarvestError,
	ForeignEventError,
	HostileStateKeyError,
	IdempotencyClaimLostError,
	type IdempotencyClaimLostErrorOptions,
	IdempotencyCompletionWithoutClaimError,
	IdempotencyInFlightError,
	type IdempotencyInFlightErrorOptions,
	IdempotencyKeyReuseError,
	type IdempotencyKeyReuseErrorOptions,
	IdempotencyReconciliationRequiredError,
	type IdempotencyReconciliationRequiredErrorOptions,
	InfrastructureError,
	InMemoryCapacityExceededError,
	type InMemoryCapacityExceededErrorOptions,
	InvalidCommandMessageError,
	InvalidIntegrationMessageError,
	type KitErrorCode,
	type KitErrorOptions,
	MisaddressedEventError,
	MissingHandlerError,
	NonProgressingEventStreamPageError,
	type NonProgressingEventStreamPageErrorOptions,
	ProjectionGapError,
	ProjectionIdentityViolationError,
	ProjectionOrderViolationError,
	ProjectionReceiptViolationError,
	ReentrantEventRecordingError,
	isDomainErrorLike,
	isInfrastructureErrorLike,
	SnapshotCorruptedError,
	SnapshotSchemaMismatchError,
	type SnapshotSchemaMismatchErrorOptions,
	UnenrolledChangesError,
	UnmintedEventError,
	UnprojectableEventError,
	UnregisteredHandlerError,
	type UnregisteredHandlerErrorOptions,
	UnreplayableAggregateError,
} from "./core/errors";
export type { Id, IdGenerator } from "./core/id";
// Deadlines: durable timeout-as-input
export {
	DeadlineProcessor,
	type DeadlineProcessorObservers,
	type DeadlineProcessorOptions,
} from "./deadlines/deadline-processor";
export type {
	DeadLetterDeadline,
	DeadlineStore,
	DueDeadline,
} from "./deadlines/deadline-store";
export {
	InMemoryDeadlineStore,
	type InMemoryDeadlineStoreOptions,
} from "./deadlines/in-memory-deadline-store";

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
	type StateValidator,
	sameEntity,
	updateEntityById,
} from "./entity/entity";

// Events: bus, outbox, dispatcher, ports
export { EventBusImpl } from "./events/event-bus";
export {
	createIntegrationMessage,
	decodeIntegrationMessage,
	encodeIntegrationMessage,
	type IntegrationMessage,
	type IntegrationMessageContent,
	type IntegrationMessageMapper,
	type IntegrationMessageRelationships,
	integrationMessageToCommittedEvent,
	type JsonObject,
	type JsonPrimitive,
	type JsonValue,
} from "./events/integration-message";
export {
	InMemoryOutbox,
	type InMemoryOutboxOptions,
	outboxWriterAcceptingEventLoss,
} from "./events/outbox";
export {
	eventBusSink,
	OutboxDispatcher,
	type OutboxDispatcherObservers,
	type OutboxDispatcherOptions,
	type OutboxSink,
} from "./events/outbox-dispatcher";
export type {
	CommitPosition,
	CommittedDomainEvent,
	DeadLetterRecord,
	DispatchTrackingOutbox,
	EventBus,
	EventCommitCandidate,
	EventCommitCandidatePosition,
	EventHandler,
	OnceOptions,
	Outbox,
	OutboxRecord,
	OutboxWriter,
	PublishOptions,
} from "./events/ports";
// Projections: checkpoint port, runner, in-memory reference
export {
	InMemoryProjectionCheckpointStore,
	type InMemoryProjectionCheckpointStoreOptions,
} from "./projections/in-memory-checkpoint-store";
export {
	isPositionAfter,
	type Projection,
	type ProjectionCheckpoint,
	type ProjectionCheckpointStore,
	type ProjectionPosition,
} from "./projections/ports";
export {
	ignoreProjectionEvent,
	type ProjectionEventHandler,
	type ProjectionFromHandlersOptions,
	type ProjectionHandlers,
	projectionFromHandlers,
} from "./projections/projection-from-handlers";
export {
	type ProjectionBatchResult,
	type ProjectOptions,
	Projector,
	type ProjectorOptions,
} from "./projections/projector";
// Repository: ports, identity map, event store, scopes
export type {
	EventStore,
	EventStoreAppendOptions,
	ReadStreamOptions,
	StreamReadResult,
} from "./repo/event-store";
export { type AggregateClass, IdentityMap } from "./repo/identity-map";
export {
	InMemoryEventStore,
	type InMemoryEventStoreOptions,
} from "./repo/in-memory-event-store";
export {
	InMemorySnapshotStore,
	type InMemorySnapshotStoreOptions,
} from "./repo/in-memory-snapshot-store";
export {
	capturePersistenceBaseline,
	derivePersistenceChanges,
	insertPersistenceBaseline,
	type PersistenceBaseline,
	type PersistenceChanges,
	type PersistenceLifecycle,
	type PersistenceModel,
	persistenceProjectionDrifted,
	recapturePersistenceBaseline,
} from "./repo/persistence-model";
export type { AggregatePersistence, Repository } from "./repo/repository";
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
export {
	captureAggregateSnapshot,
	defineSnapshotModel,
	reconstituteAggregateFromSnapshot,
	type SnapshotModel,
} from "./repo/snapshot-model";
export type { SnapshotStore } from "./repo/snapshot-store";
// Specifications
export {
	Specification,
	type SpecificationComposite,
	specification,
} from "./specification/specification";
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
export type {
	DeliveryFailureAssessment,
	DeliveryFailureClassifier,
	DeliveryFailureKind,
} from "./utils/delivery-failure";
export type { ExecutionContext } from "./utils/execution";

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
