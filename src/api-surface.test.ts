import { describe, expect, it } from "vite-plus/test";
import * as http from "./http";
import type {
	AggregatePersistence,
	DeadlineProcessorObservers,
	DeliveryFailureAssessment,
	DeliveryFailureClassifier,
	DomainErrorClass,
	DurableCommandMessage,
	IAggregateRoot,
	Id,
	IntegrationMessageRelationships,
	OutboxDispatcherObservers,
	Repository,
	RepositoryTracking,
	StateValidator,
	UnitOfWorkContext,
	UnitOfWorkIdentityMap,
} from "./index";
import * as index from "./index";
import * as money from "./money";
import * as presentation from "./presentation";
import * as testing from "./testing";

type PublicExecutionContext = import("./index").ExecutionContext;
type PublicEventMetadata = import("./index").EventMetadata;
// @ts-expect-error EffectContext was replaced by the runtime-oriented ExecutionContext name in v3
type RemovedEffectContext = import("./index").EffectContext;
// @ts-expect-error IRepository was removed instead of retained as a deprecated alias
type RemovedIRepository = import("./index").IRepository;
// @ts-expect-error IUnitOfWorkRepository was removed with the legacy save/delete protocol
type RemovedIUnitOfWorkRepository = import("./index").IUnitOfWorkRepository;
// @ts-expect-error the unscoped write-capable session was replaced by read-only RepositoryTracking
type RemovedUnitOfWorkSession = import("./index").UnitOfWorkSession;
type PublicContractRepository = import("./testing").ContractRepository<
	IAggregateRoot<Id<"RemovedRepositoryContract">>
>;

type IndexModule = typeof import("./index");
// @ts-expect-error module-level clock mutation was removed in favour of instance-bound factories
type RemovedResetClockFactory = IndexModule["resetClockFactory"];
// @ts-expect-error module-level event-id mutation was removed in favour of instance-bound factories
type RemovedResetEventIdFactory = IndexModule["resetEventIdFactory"];
// @ts-expect-error module-level clock mutation was removed in favour of instance-bound factories
type RemovedSetClockFactory = IndexModule["setClockFactory"];
// @ts-expect-error module-level event-id mutation was removed in favour of instance-bound factories
type RemovedSetEventIdFactory = IndexModule["setEventIdFactory"];
// @ts-expect-error scoped module mutation was removed in favour of instance-bound factories
type RemovedWithClockFactory = IndexModule["withClockFactory"];
// @ts-expect-error scoped module mutation was removed in favour of instance-bound factories
type RemovedWithEventIdFactory = IndexModule["withEventIdFactory"];

type RemovedFactoryMutationSurface =
	| RemovedResetClockFactory
	| RemovedResetEventIdFactory
	| RemovedSetClockFactory
	| RemovedSetEventIdFactory
	| RemovedWithClockFactory
	| RemovedWithEventIdFactory;

void (undefined as unknown as RemovedFactoryMutationSurface);

function assertReadonlyEventMetadata(metadata: PublicEventMetadata): void {
	// @ts-expect-error event metadata is immutable at the TypeScript boundary
	metadata.correlationId = "changed";
	// @ts-expect-error custom event metadata is immutable too
	metadata.custom = "changed";
}
void assertReadonlyEventMetadata;

type LifecycleSurface = IAggregateRoot<Id<"ApiSurface">>;
// @ts-expect-error persistence acknowledgement belongs to the application shell
type RemovedMarkPersisted = LifecycleSurface["markPersisted"];
// @ts-expect-error pending-event disposal is a kit-internal persistence capability
type RemovedClearPendingEvents = LifecycleSurface["clearPendingEvents"];

void (undefined as unknown as RemovedMarkPersisted);
void (undefined as unknown as RemovedClearPendingEvents);

type StateAggregateSurface = import("./index").AggregateRoot<
	unknown,
	Id<"StateAggregateSurface">
>;
// @ts-expect-error snapshot envelope construction belongs to the adapter model
type RemovedCreateSnapshot = StateAggregateSurface["createSnapshot"];
// @ts-expect-error snapshot reconstitution creates a fresh aggregate through the adapter model
type RemovedRestoreFromSnapshot = StateAggregateSurface["restoreFromSnapshot"];
type EventSourcedAggregateSurface = import("./index").EventSourcedAggregate<
	unknown,
	never,
	Id<"EventSourcedAggregateSurface">
>;
type RemovedRestoreFromSnapshotWithEvents =
	// @ts-expect-error snapshot-plus-tail loading is composed by the repository adapter
	EventSourcedAggregateSurface["restoreFromSnapshotWithEvents"];
void (undefined as unknown as RemovedCreateSnapshot);
void (undefined as unknown as RemovedRestoreFromSnapshot);
void (undefined as unknown as RemovedRestoreFromSnapshotWithEvents);

const publicStateValidator: StateValidator<{ value: number }> = (state) => {
	void state.value;
};
void publicStateValidator;

const publicOutboxObservers: OutboxDispatcherObservers<never> = {
	onDispatchError: () => {},
	onPollError: () => {},
	onDeadLetter: () => {},
};
const publicDeadlineObservers: DeadlineProcessorObservers<never> = {
	onDeliveryError: () => {},
	onPollError: () => {},
	onDeadLetter: () => {},
};
const publicDeliveryClassifier: DeliveryFailureClassifier = () => "unknown";
const publicDeliveryAssessment: DeliveryFailureAssessment = { kind: "unknown" };
void publicOutboxObservers;
void publicDeadlineObservers;
void publicDeliveryClassifier;
void publicDeliveryAssessment;
void (undefined as unknown as PublicExecutionContext);
void (undefined as unknown as RemovedEffectContext);
void (undefined as unknown as RemovedIRepository);
void (undefined as unknown as RemovedIUnitOfWorkRepository);
void (undefined as unknown as RemovedUnitOfWorkSession);
void (undefined as unknown as PublicContractRepository);

type PublicRepositoryContracts =
	| AggregatePersistence<
			IAggregateRoot<Id<"PersistenceSurface">>,
			Id<"PersistenceSurface">
	  >
	| Repository<
			IAggregateRoot<Id<"RepositorySurface">>,
			Id<"RepositorySurface">
	  >;
void (undefined as unknown as PublicRepositoryContracts);

type PublicUnitOfWorkContext = UnitOfWorkContext<{
	readonly orders: unknown;
}>;
// @ts-expect-error application work cannot access an adapter transaction
type RemovedRawTransaction = PublicUnitOfWorkContext["rawTransaction"];
// @ts-expect-error application work cannot access adapter tracking internals
type RemovedTrackingSession = PublicUnitOfWorkContext["session"];
type PublicRepositoryTracking = RepositoryTracking<
	IAggregateRoot<Id<"TrackingSurface">>
>;
// @ts-expect-error legacy enrollment cannot bypass explicit add/update intent
type RemovedEnrollSaved = PublicRepositoryTracking["enrollSaved"];
// @ts-expect-error adapters cannot mutate the Unit-of-Work-owned identity map
type RemovedIdentityMapSet = UnitOfWorkIdentityMap["set"];
void (undefined as unknown as RemovedRawTransaction);
void (undefined as unknown as RemovedTrackingSession);
void (undefined as unknown as RemovedEnrollSaved);
void (undefined as unknown as RemovedIdentityMapSet);

const publicIntegrationRelationships: IntegrationMessageRelationships = {
	correlationId: "corr-1",
	conversationId: "conversation-1",
	causationId: "cause-1",
};
void publicIntegrationRelationships;
void (undefined as unknown as DurableCommandMessage<{
	type: "RebuildReadModel";
	version: 1;
	payload: null;
}>);
void (undefined as unknown as DomainErrorClass);

/**
 * Pins the RUNTIME public API surface of every package entry point. The
 * entries use curated named exports (no `export *`), so nothing internal
 * can leak by accident; this test turns an accidental addition or
 * removal into a loud, reviewable diff of the lists below. Removing a
 * name is a breaking change (major); adding one belongs in the
 * CHANGELOG. Type-only exports are invisible at runtime and are guarded
 * by the named-export lists in the entry files themselves.
 */

const INDEX_SURFACE = [
	"AggregateDeletedError",
	"AggregateNotFoundError",
	"AggregateRoot",
	"AggregateTrackingError",
	"CommandBus",
	"CommitError",
	"ConcurrencyConflictError",
	"DeadlineProcessor",
	"DomainError",
	"DomainEventValidationError",
	"DomainStateMachine",
	"DomainTransitionGuardRejectedError",
	"DuplicateAggregateError",
	"DuplicateEventIdError",
	"DuplicateHandlerRegistrationError",
	"Entity",
	"ErrorMapperFailedError",
	"EventBusImpl",
	"EventHarvestError",
	"EventSourcedAggregate",
	"ForeignEventError",
	"HostileStateKeyError",
	"IdempotencyClaimLostError",
	"IdempotencyCompletionWithoutClaimError",
	"IdempotencyInFlightError",
	"IdempotencyKeyReuseError",
	"IdempotencyReconciliationRequiredError",
	"IdentityMap",
	"InMemoryCapacityExceededError",
	"InMemoryDeadlineStore",
	"InMemoryEventStore",
	"InMemoryIdempotencyStore",
	"InMemoryOutbox",
	"InMemoryProjectionCheckpointStore",
	"InMemorySnapshotStore",
	"InfrastructureError",
	"InvalidCommandMessageError",
	"InvalidDomainMachineContextError",
	"InvalidDomainMachineDefinitionError",
	"InvalidDomainMachineInputError",
	"InvalidDomainMachineSnapshotError",
	"InvalidDomainTransitionError",
	"InvalidDomainTransitionGuardResultError",
	"InvalidDomainTransitionResultError",
	"InvalidIntegrationMessageError",
	"InvalidRepositoryAdapterError",
	"InvalidRepositoryDefinitionError",
	"MisaddressedEventError",
	"MissingHandlerError",
	"NestedUnitOfWorkError",
	"NonProgressingEventStreamPageError",
	"OutboxDispatcher",
	"ProjectionGapError",
	"ProjectionIdentityViolationError",
	"ProjectionOrderViolationError",
	"ProjectionReceiptViolationError",
	"Projector",
	"QueryBus",
	"ReentrantDomainStateMachineEvaluationError",
	"ReentrantEventRecordingError",
	"RepositoryErrorMappingFailedError",
	"RetryingTransactionScope",
	"RollbackError",
	"SnapshotCorruptedError",
	"SnapshotSchemaMismatchError",
	"SnapshotTimeValidationError",
	"Specification",
	"TransactionClosedError",
	"UnenrolledChangesError",
	"UnitOfWork",
	"UnmintedEventError",
	"UnprojectableEventError",
	"UnregisteredHandlerError",
	"UnreplayableAggregateError",
	"ValueObject",
	"analyzeDomainMachineDefinition",
	"canTransitionDomainState",
	"captureAggregateSnapshot",
	"capturePersistenceBaseline",
	"copyMetadata",
	"createDomainEvent",
	"createDomainEventFactory",
	"createDomainEventFromFacts",
	"createInitialDomainMachineSnapshot",
	"createIntegrationMessage",
	"createUncommittedDomainEvent",
	"decodeIntegrationMessage",
	"deepEqual",
	"deepEqualExcept",
	"deepFreeze",
	"deepOmit",
	"defaultDomainEventFactory",
	"defineRepository",
	"defineSnapshotModel",
	"derivePersistenceChanges",
	"domainErrorToResult",
	"encodeIntegrationMessage",
	"entityIds",
	"eventBusSink",
	"findEntityById",
	"freezeShallow",
	"hasEntityId",
	"ignoreProjectionEvent",
	"insertPersistenceBaseline",
	"integrationMessageToCommittedEvent",
	"isDomainErrorLike",
	"isInfrastructureErrorLike",
	"isPositionAfter",
	"mergeMetadata",
	"outboxWriterAcceptingEventLoss",
	"persistenceProjectionDrifted",
	"prepareDomainMachineDefinition",
	"projectionFromHandlers",
	"recapturePersistenceBaseline",
	"reconstituteAggregateFromSnapshot",
	"recordDomainEvent",
	"recordPendingEvents",
	"removeEntityById",
	"replaceEntityById",
	"routeEventsToCommandOutbox",
	"sameEntity",
	"sameVersion",
	"specification",
	"transitionDomainState",
	"updateEntityById",
	"vo",
	"voEquals",
	"voEqualsExcept",
	"voValidated",
	"voWithValidation",
	"withCommit",
	"withIdempotentCommit",
] as const;

const TESTING_SURFACE = [
	"createCommandOutboxContractTests",
	"createDeadlineStoreContractTests",
	"createEsRepositoryContractTests",
	"createEventStoreContractTests",
	"createIdempotencyStoreContractTests",
	"createOutboxContractTests",
	"createProjectionCheckpointStoreContractTests",
	"createRepositoryContractTests",
	"createSnapshotStoreContractTests",
] as const;

const HTTP_SURFACE = ["toProblemDetails"] as const;

const PRESENTATION_SURFACE = [
	"createKitPublicErrors",
	"toPublicErrorView",
] as const;

const MONEY_SURFACE = [
	"InvalidMoneyError",
	"MoneyCurrencyMismatchError",
	"MoneyPrecisionLossError",
	"MoneyScaleMismatchError",
	"UnknownCurrencyError",
	"addMoney",
	"createMoneyFactory",
	"createMoneyFormatter",
	"currencyScaleFromIntl",
	"currencyScaleFromRecord",
	"formatMoney",
	"isMoney",
	"isNegativeMoney",
	"isPositiveMoney",
	"isZeroMoney",
	"moneyEquals",
	"moneyFromDto",
	"moneyFromSnapshot",
	"moneyFromUnknown",
	"moneyOfMinor",
	"moneyToDecimalString",
	"moneyToDto",
	"moneyToSnapshot",
	"negateMoney",
	"parseMoneyInput",
	"rescaleMoney",
	"subtractMoney",
	"tryMoneyFromDto",
	"tryMoneyFromSnapshot",
	"tryParseMoneyInput",
] as const;

describe("public API surface (runtime exports)", () => {
	it("the main entry exports exactly the pinned names", () => {
		expect(Object.keys(index).sort()).toEqual([...INDEX_SURFACE]);
	});

	it("the testing entry exports exactly the pinned names", () => {
		expect(Object.keys(testing).sort()).toEqual([...TESTING_SURFACE]);
	});

	it("the http entry exports exactly the pinned names", () => {
		expect(Object.keys(http).sort()).toEqual([...HTTP_SURFACE]);
	});

	it("the presentation entry exports exactly the pinned names", () => {
		expect(Object.keys(presentation).sort()).toEqual([...PRESENTATION_SURFACE]);
	});

	it("the money entry exports exactly the pinned names", () => {
		expect(Object.keys(money).sort()).toEqual([...MONEY_SURFACE]);
	});
});
