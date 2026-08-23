// Main entry point (`@shirudo/ddd-kit`). Every export is named
// deliberately: the SemVer surface is exactly this list, internals never
// leak by accident, and `src/api-surface.test.ts` pins the runtime part.
// Result types come from the peer dependency `@shirudo/result`;
// `ValidationError` comes from `@shirudo/base-error`; RFC 9457 Problem
// Details presenters live in the opt-in `@shirudo/ddd-kit/http` entry;
// the repository contract suites live in `@shirudo/ddd-kit/testing`.

// CQRS: commands, queries, buses
export type {
	Command,
	CommandHandler,
	PublishedCommand,
} from "./application/cqrs/command/command";
export {
	CommandBus,
	type CommandBusOptions,
	type ICommandBus,
} from "./application/cqrs/command/command-bus";
export {
	type CommandCommitOriginCandidate,
	type CommandMessageContent,
	type CommandMessageRelationships,
	type CommandOutboxCommitCandidate,
	type CommandOutboxMapper,
	type CommandOutboxWriter,
	type DurableCommandMessage,
	routeEventsToCommandOutbox,
} from "./application/cqrs/command/command-outbox";
// App orchestration: withCommit + Unit of Work
export {
	type AggregateCommitToken,
	type CommitEnrollment,
	type CommitEnrollmentOptions,
	type WithCommitDeps,
	type WithCommitWorkResult,
	withCommit,
} from "./application/cqrs/handler";
export type { Query, QueryHandler } from "./application/cqrs/query/query";
export {
	type IQueryBus,
	QueryBus,
	type QueryBusOptions,
} from "./application/cqrs/query/query-bus";
export {
	InMemoryDeadlineStore,
	type InMemoryDeadlineStoreOptions,
} from "./application/deadlines/adapters/in-memory-deadline-store";
// Deadlines: durable timeout-as-input
export {
	DeadlineProcessor,
	type DeadlineProcessorObservers,
	type DeadlineProcessorOptions,
} from "./application/deadlines/deadline-processor";
export type {
	DeadLetterDeadline,
	DeadlineStore,
	DueDeadline,
} from "./application/deadlines/deadline-store";
export {
	type DomainErrorClass,
	domainErrorToResult,
} from "./application/domain-error-result";
export {
	InMemoryIdempotencyStore,
	type InMemoryIdempotencyStoreOptions,
} from "./application/idempotency/adapters/in-memory-idempotency-store";
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
} from "./application/idempotency/idempotency";
// Projections: checkpoint port, runner, in-memory reference
export {
	InMemoryProjectionCheckpointStore,
	type InMemoryProjectionCheckpointStoreOptions,
} from "./application/projections/adapters/in-memory-checkpoint-store";
export {
	isPositionAfter,
	type Projection,
	type ProjectionCheckpoint,
	type ProjectionCheckpointStore,
	type ProjectionPosition,
} from "./application/projections/ports";
export {
	ignoreProjectionEvent,
	type ProjectionEventHandler,
	type ProjectionFromHandlersOptions,
	type ProjectionHandlers,
	projectionFromHandlers,
} from "./application/projections/projection-from-handlers";
export {
	type ProjectionBatchResult,
	type ProjectOptions,
	Projector,
	type ProjectorOptions,
} from "./application/projections/projector";
export {
	AggregateTrackingError,
	type AggregateTrackingFailure,
	CommitError,
	InvalidRepositoryAdapterError,
	InvalidRepositoryDefinitionError,
	NestedUnitOfWorkError,
	RepositoryErrorMappingFailedError,
	RollbackError,
	TransactionClosedError,
} from "./application/unit-of-work/errors";
export type {
	AggregatePersistenceWrite,
	AggregateWriteIntent,
	RepositoryTracking,
	UnitOfWorkIdentityMap,
} from "./application/unit-of-work/persistence-contract";
export {
	type DomainEventStampFactory,
	type DomainEventStampProvider,
	recordPendingEvents,
} from "./application/unit-of-work/record-pending-events";
export {
	type AggregateWriteRegistration,
	type CompatibleRepositoryDefinitions,
	defineRepository,
	type PhysicalRemovalRegistration,
	type RepositoriesOf,
	type RepositoryDefinition,
	type RepositoryDefinitionOptions,
	type RunOptions,
	UnitOfWork,
	type UnitOfWorkContext,
	type UnitOfWorkDeps,
} from "./application/unit-of-work/unit-of-work";
// Core: errors
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
	isDomainErrorLike,
	isInfrastructureErrorLike,
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
// Aggregates: type hub
export {
	type AggregateSnapshot,
	type IAggregateRoot,
	type IEventSourcedAggregate,
	sameVersion,
	type Version,
} from "./domain/aggregate/aggregate";
export type { AggregateAddress } from "./domain/aggregate/aggregate-address";
export {
	type AggregateConfig,
	AggregateRoot,
} from "./domain/aggregate/aggregate-root";
export { EventSourcedAggregate } from "./domain/aggregate/event-sourced-aggregate";
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
} from "./domain/entity/entity";
// Domain events
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
} from "./domain/event/domain-event";
export {
	type DomainEventValidationCode,
	DomainEventValidationError,
	type DomainEventValidationField,
	SnapshotTimeValidationError,
} from "./domain/event/domain-event-errors";
// Identity
export type { Id, IdGenerator } from "./domain/identity/id";
// Specifications
export {
	Specification,
	type SpecificationComposite,
	specification,
} from "./domain/specification/specification";
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
} from "./domain/state-machine/domain-state-machine";
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
} from "./domain/value-object/value-object";
export { voValidated } from "./domain/value-object/vo-validated";
// Events: bus, outbox, dispatcher, ports
export { EventBusImpl } from "./messaging/event-bus/event-bus";
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
} from "./messaging/integration-message/integration-message";
export {
	InMemoryOutbox,
	type InMemoryOutboxOptions,
	outboxWriterAcceptingEventLoss,
} from "./messaging/outbox/outbox";
export {
	eventBusSink,
	OutboxDispatcher,
	type OutboxDispatcherObservers,
	type OutboxDispatcherOptions,
	type OutboxSink,
} from "./messaging/outbox/outbox-dispatcher";
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
} from "./messaging/ports";
// Persistence: repository, event store, snapshot store
export {
	InMemoryEventStore,
	type InMemoryEventStoreOptions,
} from "./persistence/event-store/adapters/in-memory-event-store";
export type {
	EventStore,
	EventStoreAppendOptions,
	ReadStreamOptions,
	StreamReadResult,
} from "./persistence/event-store/event-store";
export {
	type AggregateClass,
	IdentityMap,
} from "./persistence/repository/identity-map";
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
} from "./persistence/repository/persistence-model";
export type {
	AggregatePersistence,
	Repository,
} from "./persistence/repository/repository";
// computeBackoffDelay is deliberately NOT exported: internal since 2.x
// (unit-tested via direct source import), removed from the surface in v3.
export {
	RetryingTransactionScope,
	type RetryPolicy,
} from "./persistence/repository/retrying-scope";
export type {
	TransactionalOptions,
	TransactionScope,
} from "./persistence/repository/scope";
export {
	InMemorySnapshotStore,
	type InMemorySnapshotStoreOptions,
} from "./persistence/snapshot-store/adapters/in-memory-snapshot-store";
export {
	captureAggregateSnapshot,
	defineSnapshotModel,
	reconstituteAggregateFromSnapshot,
	type SnapshotModel,
} from "./persistence/snapshot-store/snapshot-model";
export type { SnapshotStore } from "./persistence/snapshot-store/snapshot-store";
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
