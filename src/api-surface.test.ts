import { describe, expect, it } from "vite-plus/test";
import type {
	DeadlineProcessorObservers,
	DomainErrorClass,
	IAggregateRoot,
	Id,
	IntegrationMessageRelationships,
	OutboxDispatcherObservers,
	StateValidator,
} from "./index";
import * as http from "./http";
import * as index from "./index";
import * as money from "./money";
import * as presentation from "./presentation";
import * as testing from "./testing";
import * as utils from "./utils";

// @ts-expect-error module-level clock mutation was removed in favour of instance-bound factories
import type { resetClockFactory as RemovedResetClockFactory } from "./index";
// @ts-expect-error module-level event-id mutation was removed in favour of instance-bound factories
import type { resetEventIdFactory as RemovedResetEventIdFactory } from "./index";
// @ts-expect-error module-level clock mutation was removed in favour of instance-bound factories
import type { setClockFactory as RemovedSetClockFactory } from "./index";
// @ts-expect-error module-level event-id mutation was removed in favour of instance-bound factories
import type { setEventIdFactory as RemovedSetEventIdFactory } from "./index";
// @ts-expect-error scoped module mutation was removed in favour of instance-bound factories
import type { withClockFactory as RemovedWithClockFactory } from "./index";
// @ts-expect-error scoped module mutation was removed in favour of instance-bound factories
import type { withEventIdFactory as RemovedWithEventIdFactory } from "./index";

type RemovedFactoryMutationSurface =
	| typeof RemovedResetClockFactory
	| typeof RemovedResetEventIdFactory
	| typeof RemovedSetClockFactory
	| typeof RemovedSetEventIdFactory
	| typeof RemovedWithClockFactory
	| typeof RemovedWithEventIdFactory;

void (undefined as unknown as RemovedFactoryMutationSurface);

type PublicAggregateLifecycleSurface = IAggregateRoot<Id<"ApiSurface">>;
// @ts-expect-error persistence acknowledgement belongs to the application shell
type RemovedMarkPersisted = PublicAggregateLifecycleSurface["markPersisted"];
type RemovedClearPendingEvents =
	PublicAggregateLifecycleSurface[
		// @ts-expect-error pending-event disposal is a kit-internal persistence capability
		"clearPendingEvents"
	];

void (undefined as unknown as RemovedMarkPersisted);
void (undefined as unknown as RemovedClearPendingEvents);

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
void publicOutboxObservers;
void publicDeadlineObservers;

const publicIntegrationRelationships: IntegrationMessageRelationships = {
	correlationId: "corr-1",
	conversationId: "conversation-1",
	causationId: "cause-1",
};
void publicIntegrationRelationships;
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
	"CommandBus",
	"CommitError",
	"ConcurrencyConflictError",
	"DeadlineProcessor",
	"DomainError",
	"DomainStateMachine",
	"DomainTransitionGuardRejectedError",
	"DuplicateAggregateError",
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
	"InvalidDomainMachineContextError",
	"InvalidDomainMachineDefinitionError",
	"InvalidDomainMachineInputError",
	"InvalidDomainMachineSnapshotError",
	"InvalidDomainTransitionError",
	"InvalidDomainTransitionGuardResultError",
	"InvalidDomainTransitionResultError",
	"InvalidIntegrationMessageError",
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
	"RetryingTransactionScope",
	"RollbackError",
	"SnapshotCorruptedError",
	"SnapshotSchemaMismatchError",
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
	"copyMetadata",
	"createDomainEvent",
	"createDomainEventFactory",
	"createInitialDomainMachineSnapshot",
	"createIntegrationMessage",
	"decodeIntegrationMessage",
	"deepEqual",
	"deepEqualExcept",
	"deepFreeze",
	"deepOmit",
	"defaultDomainEventFactory",
	"domainErrorToResult",
	"encodeIntegrationMessage",
	"entityIds",
	"eventBusSink",
	"findEntityById",
	"freezeShallow",
	"hasEntityId",
	"ignoreProjectionEvent",
	"integrationMessageToCommittedEvent",
	"isPositionAfter",
	"mergeMetadata",
	"outboxWriterAcceptingEventLoss",
	"prepareDomainMachineDefinition",
	"projectionFromHandlers",
	"removeEntityById",
	"replaceEntityById",
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

const UTILS_SURFACE = ["deepEqual", "deepEqualExcept", "deepOmit"] as const;

const TESTING_SURFACE = [
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

	it("the utils entry exports exactly the pinned names", () => {
		expect(Object.keys(utils).sort()).toEqual([...UTILS_SURFACE]);
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
