import { describe, expect, it } from "vite-plus/test";
import type {
	Aggregate,
	AggregatePersistence,
	DeadlineProcessorObservers,
	DeliveryFailureAssessment,
	DeliveryFailureClassifier,
	DomainErrorClass,
	DurableCommandMessage,
	Id,
	IntegrationMessageRelationships,
	OutboxDispatcherObservers,
	Repository,
	RepositoryTracking,
	StateValidator,
	UnitOfWorkContext,
	UnitOfWorkIdentityMap,
} from "../../src";
import * as index from "../../src";
import * as money from "../../src/domain/value-object/money";
import * as presentation from "../../src/presentation/errors";
import * as http from "../../src/presentation/http/problem-details";
import * as testing from "../../src/testing";

type PublicExecutionContext = import("../../src").ExecutionContext;
type PublicEventMetadata = import("../../src").EventMetadata;
type PublicContractRepository = import("../../src/testing").ContractRepository<
	Aggregate<Id<"ContractRepositorySurface">>
>;

function assertReadonlyEventMetadata(metadata: PublicEventMetadata): void {
	// @ts-expect-error event metadata is immutable at the TypeScript boundary
	metadata.correlationId = "changed";
	// @ts-expect-error custom event metadata is immutable too
	metadata.custom = "changed";
}
void assertReadonlyEventMetadata;

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
void (undefined as unknown as PublicContractRepository);

type PublicRepositoryContracts =
	| AggregatePersistence<
			Aggregate<Id<"PersistenceSurface">>,
			Id<"PersistenceSurface">
	  >
	| Repository<Aggregate<Id<"RepositorySurface">>, Id<"RepositorySurface">>;
void (undefined as unknown as PublicRepositoryContracts);

type PublicUnitOfWorkContext = UnitOfWorkContext<{
	readonly orders: unknown;
}>;
// @ts-expect-error application work cannot access an adapter transaction
type RemovedRawTransaction = PublicUnitOfWorkContext["rawTransaction"];
// @ts-expect-error application work cannot access adapter tracking internals
type RemovedTrackingSession = PublicUnitOfWorkContext["session"];
type PublicRepositoryTracking = RepositoryTracking<
	Aggregate<Id<"TrackingSurface">>
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
	"AggregateTrackingError",
	"CapabilityRegistryConflictError",
	"CommandBus",
	"CommitError",
	"ConcurrencyConflictError",
	"DeadlineProcessor",
	"DirectStateMutationError",
	"DomainError",
	"DomainEventValidationError",
	"DomainStateMachine",
	"DomainTransitionGuardRejectedError",
	"DuplicateAggregateError",
	"DuplicateEventIdError",
	"DuplicateHandlerRegistrationError",
	"Entity",
	"ErrorMapperFailedError",
	"EventBusClosedError",
	"EventBusImpl",
	"EventHarvestError",
	"EventSourcedAggregate",
	"ForeignEventError",
	"HandlerReturnedNoStateError",
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
	"InvalidVersionError",
	"MisaddressedEventError",
	"MissingEntityIdError",
	"MissingHandlerError",
	"NestedUnitOfWorkError",
	"NonProgressingEventStreamPageError",
	"OutboxDispatcher",
	"PendingEventBatchMismatchError",
	"ProjectionGapError",
	"ProjectionIdentityViolationError",
	"ProjectionOrderViolationError",
	"ProjectionReceiptViolationError",
	"Projector",
	"PublishDepthExceededError",
	"QueryBus",
	"ReentrantDomainStateMachineEvaluationError",
	"ReentrantEventRecordingError",
	"ReplayHeadMismatchError",
	"RepositoryErrorMappingFailedError",
	"RetryingTransactionScope",
	"RollbackError",
	"SnapshotCorruptedError",
	"SnapshotSchemaMismatchError",
	"SnapshotTimeValidationError",
	"Specification",
	"StateStoredAggregate",
	"TransactionClosedError",
	"UnenrolledChangesError",
	"UnitOfWork",
	"UnmanagedInstanceError",
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
	"reconstituteAggregateFromHistory",
	"reconstituteAggregateFromSnapshot",
	"recordDomainEvent",
	"recordPendingEvents",
	"removeEntityById",
	"replaceEntityById",
	"routeEventsToCommandOutbox",
	"sameEntity",
	"sameVersion",
	"specification",
	"toVersion",
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
	"createEventBusContractTests",
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
