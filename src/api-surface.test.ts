import { describe, expect, it } from "vitest";
import * as http from "./http";
import * as index from "./index";
import * as presentation from "./presentation";
import * as testing from "./testing";
import * as utils from "./utils";

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
	"DomainError",
	"DomainStateMachine",
	"DomainTransitionGuardRejectedError",
	"DuplicateAggregateError",
	"Entity",
	"ErrorMapperFailedError",
	"EventBusImpl",
	"EventHarvestError",
	"EventSourcedAggregate",
	"HostileStateKeyError",
	"IdentityMap",
	"InMemoryEventStore",
	"InMemoryOutbox",
	"InfrastructureError",
	"InvalidDomainMachineContextError",
	"InvalidDomainMachineDefinitionError",
	"InvalidDomainMachineInputError",
	"InvalidDomainMachineSnapshotError",
	"InvalidDomainTransitionError",
	"InvalidDomainTransitionGuardResultError",
	"InvalidDomainTransitionResultError",
	"MissingHandlerError",
	"NestedUnitOfWorkError",
	"QueryBus",
	"ReentrantDomainStateMachineEvaluationError",
	"RetryingTransactionScope",
	"RollbackError",
	"SnapshotSchemaMismatchError",
	"TransactionClosedError",
	"UnenrolledChangesError",
	"UnitOfWork",
	"UnregisteredHandlerError",
	"UnreplayableAggregateError",
	"ValueObject",
	"analyzeDomainMachineDefinition",
	"canTransitionDomainState",
	"copyMetadata",
	"createDomainEvent",
	"createInitialDomainMachineSnapshot",
	"deepEqual",
	"deepEqualExcept",
	"deepFreeze",
	"deepOmit",
	"entityIds",
	"findEntityById",
	"freezeShallow",
	"hasEntityId",
	"mergeMetadata",
	"prepareDomainMachineDefinition",
	"removeEntityById",
	"replaceEntityById",
	"resetClockFactory",
	"resetEventIdFactory",
	"sameEntity",
	"sameVersion",
	"setClockFactory",
	"setEventIdFactory",
	"transitionDomainState",
	"updateEntityById",
	"vo",
	"voEquals",
	"voEqualsExcept",
	"voValidated",
	"voWithValidation",
	"withClockFactory",
	"withCommit",
	"withEventIdFactory",
] as const;

const UTILS_SURFACE = ["deepEqual", "deepEqualExcept", "deepOmit"] as const;

const TESTING_SURFACE = [
	"createEsRepositoryContractTests",
	"createRepositoryContractTests",
] as const;

const HTTP_SURFACE = ["toProblemDetails"] as const;

const PRESENTATION_SURFACE = ["toPublicErrorView"] as const;

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
});
