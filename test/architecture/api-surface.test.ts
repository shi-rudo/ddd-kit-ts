import { describe, expect, it } from "vite-plus/test";
import type {
	Aggregate,
	AggregatePersistence,
	CreateEventOptions,
	DeadlineProcessorObservers,
	DeliveryFailureAssessment,
	DeliveryFailureClassifier,
	DomainErrorClass,
	DomainEvent,
	DurableCommandMessage,
	Fold,
	ICommandBus,
	Id,
	IntegrationMessageRelationships,
	IQueryBus,
	OutboxDispatcherObservers,
	Repository,
	RepositoryTracking,
	StateValidator,
	UnitOfWorkContext,
	UnitOfWorkIdentityMap,
} from "../../src";
import * as index from "../../src";
import * as stateMachine from "../../src/domain/state-machine";
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

// The buses have private fields, so an object literal cannot take the class
// type. A test double or another bus implements the port interface.
const fakeCommandBus: ICommandBus = {
	execute: async () => {
		throw new Error("not dispatched");
	},
	register: () => {},
};
const fakeQueryBus: IQueryBus = {
	execute: async () => {
		throw new Error("not dispatched");
	},
	executeUnsafe: async () => {
		throw new Error("not dispatched");
	},
	register: () => {},
};
void fakeCommandBus;
void fakeQueryBus;

// A consumer names the types of the public signatures: a fold written as a
// function sits in `folds`, a domain method forwards the options of
// createEvent, and a bus takes a type map declared as an interface.
type OrderConfirmed = DomainEvent<"OrderConfirmed", { orderId: string }>;
const countConfirmed: Fold<number, OrderConfirmed> = (confirmed) =>
	confirmed + 1;
class ConfirmationCounter extends index.EventSourcedAggregate<
	number,
	Id<"CounterId">,
	OrderConfirmed
> {
	protected readonly aggregateType = "ConfirmationCounter";
	protected readonly folds = { OrderConfirmed: countConfirmed };

	confirm(orderId: string, options: CreateEventOptions): void {
		this.apply(this.createEvent("OrderConfirmed", { orderId }, options));
	}
}
interface InterfaceCommandMap {
	PlaceOrder: Id<"OrderId">;
}
interface InterfaceQueryMap {
	OrderById: { readonly status: string } | undefined;
}
void ConfirmationCounter;
void (undefined as unknown as index.CommandBus<InterfaceCommandMap>);
void (undefined as unknown as ICommandBus<InterfaceCommandMap>);
void (undefined as unknown as index.QueryBus<InterfaceQueryMap>);
void (undefined as unknown as IQueryBus<InterfaceQueryMap>);

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

// The testing entry names the types of its own signatures: one test of any
// suite, and the data shapes that the deadline and snapshot suites store.
type PublicContractTest = import("../../src/testing").ContractTest;
type PublicDeadlinePayload =
	import("../../src/testing").DeadlineStoreContractPayload;
type PublicSnapshotState =
	import("../../src/testing").SnapshotStoreContractState;
const bindContractTests = (tests: ReadonlyArray<PublicContractTest>) =>
	tests.map((test) => test.name);
const storedPayload: PublicDeadlinePayload = { kind: "payment-timeout" };
const storedState: PublicSnapshotState = { total: 0, items: [] };
void bindContractTests;
void storedPayload;
void storedState;

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
// @ts-expect-error legacy registration cannot bypass explicit add/update intent
type RemovedRegisterSaved = PublicRepositoryTracking["registerSaved"];
// @ts-expect-error adapters cannot mutate the Unit-of-Work-owned identity map
type RemovedIdentityMapSet = UnitOfWorkIdentityMap["set"];
void (undefined as unknown as RemovedRawTransaction);
void (undefined as unknown as RemovedTrackingSession);
void (undefined as unknown as RemovedRegisterSaved);
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
	"DuplicateAggregateError",
	"DuplicateEventIdError",
	"DuplicateHandlerRegistrationError",
	"Entity",
	"ErrorMapperFailedError",
	"EventBusClosedError",
	"EventCollectionError",
	"EventSourcedAggregate",
	"FoldReturnedNoStateError",
	"ForeignEventError",
	"HandBuiltEventError",
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
	"InMemoryTransactionScope",
	"InProcessEventBus",
	"InfrastructureError",
	"InvalidCommandMessageError",
	"InvalidEventStreamPageError",
	"InvalidFlushStatementError",
	"InvalidIntegrationMessageError",
	"InvalidRepositoryAdapterError",
	"InvalidRepositoryDefinitionError",
	"InvalidVersionError",
	"MisattributedEventError",
	"MissingEntityIdError",
	"MissingFoldError",
	"MissingHandlerError",
	"NestedUnitOfWorkError",
	"OutboxDispatcher",
	"PendingEventBatchMismatchError",
	"PendingEventLimitExceededError",
	"ProjectionGapError",
	"ProjectionIdentityViolationError",
	"ProjectionOrderViolationError",
	"ProjectionReceiptViolationError",
	"Projector",
	"PrototypePollutionError",
	"PublishDepthExceededError",
	"QueryBus",
	"ReentrantEventRecordingError",
	"ReplayRejectedError",
	"ReplayTargetMismatchError",
	"RepositoryErrorMappingFailedError",
	"RetryingTransactionScope",
	"RollbackError",
	"SnapshotCorruptedError",
	"SnapshotSchemaMismatchError",
	"SnapshotTimeValidationError",
	"SnapshotVersionNotRestoredError",
	"Specification",
	"StateStoredAggregate",
	"TransactionClosedError",
	"UnitOfWork",
	"UnmanagedInstanceError",
	"UnprojectableEventError",
	"UnregisteredChangesError",
	"UnregisteredHandlerError",
	"UnreplayableAggregateError",
	"ValueObject",
	"captureAggregateSnapshot",
	"classifyConcurrencyConflict",
	"copyMetadata",
	"copyPlainState",
	"createDomainEvent",
	"createDomainEventFactory",
	"createIntegrationMessage",
	"createStampedDomainEvent",
	"decodeIntegrationMessage",
	"deepEqual",
	"deepFreeze",
	"deepOmit",
	"defaultDomainEventFactory",
	"defineRepository",
	"defineSnapshotModel",
	"domainErrorToResult",
	"encodeIntegrationMessage",
	"entityIds",
	"eventBusSink",
	"findEntityById",
	"hasEntityId",
	"ignoreProjectionEvent",
	"integrationMessageToCommittedEvent",
	"isDomainErrorLike",
	"isInfrastructureErrorLike",
	"isPositionAfter",
	"isWiringErrorLike",
	"mergeMetadata",
	"outboxWriterAcceptingEventLoss",
	"pinTargetVersion",
	"projectionFromHandlers",
	"readStreamPages",
	"reconstituteAggregateFromHistory",
	"reconstituteAggregateFromSnapshot",
	"reconstituteAggregateFromStreamPages",
	"removeEntityById",
	"replaceEntityById",
	"routeEventsToCommandOutbox",
	"sameEntity",
	"sameVersion",
	"specification",
	"stampPendingEvents",
	"toVersion",
	"updateEntityById",
	"valueObject",
	"valueObjectEquals",
	"valueObjectEqualsExcept",
	"valueObjectOrError",
	"valueObjectOrIssues",
	"versionedFlush",
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
	"createReplayableStreamPages",
	"createReplayableStreamPagesContractTests",
	"createRepositoryContractTests",
	"createSnapshotStoreContractTests",
] as const;

const HTTP_SURFACE = ["toProblemDetails"] as const;

const PRESENTATION_SURFACE = [
	"createKitPublicErrors",
	"toPublicErrorView",
] as const;

const STATE_MACHINE_SURFACE = [
	"DomainStateMachine",
	"DomainTransitionGuardRejectedError",
	"InvalidDomainMachineContextError",
	"InvalidDomainMachineDefinitionError",
	"InvalidDomainMachineInputError",
	"InvalidDomainMachineSnapshotError",
	"InvalidDomainTransitionError",
	"InvalidDomainTransitionGuardResultError",
	"InvalidDomainTransitionResultError",
	"ReentrantDomainStateMachineEvaluationError",
	"analyzeDomainMachineDefinition",
	"canTransitionDomainState",
	"createInitialDomainMachineSnapshot",
	"prepareDomainMachineDefinition",
	"transitionDomainState",
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

	it("the state machine entry exports exactly the pinned names", () => {
		expect(Object.keys(stateMachine).sort()).toEqual([
			...STATE_MACHINE_SURFACE,
		]);
	});
});
