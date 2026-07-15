import { isStructuredError, matchError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import {
	AggregateDeletedError,
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DomainError,
	DuplicateAggregateError,
	ErrorMapperFailedError,
	EventHarvestError,
	HostileStateKeyError,
	InMemoryCapacityExceededError,
	InfrastructureError,
	InvalidIntegrationMessageError,
	type KitErrorCode,
	MissingHandlerError,
	NonProgressingEventStreamPageError,
	ProjectionGapError,
	ProjectionIdentityViolationError,
	ProjectionOrderViolationError,
	ProjectionReceiptViolationError,
	SnapshotSchemaMismatchError,
	UnenrolledChangesError,
	UnprojectableEventError,
	UnregisteredHandlerError,
	UnreplayableAggregateError,
} from "./errors";

// The structured-error contract for every kit error (decided 2026-07-05):
// kit errors ARE StructuredErrors. `code` is THE identifier (SCREAMING_SNAKE,
// matchError, catalogs, wire) and `name === code` by base-error's design, so
// there is exactly one identifier and no name/code drift. `category` follows
// the class hierarchy mechanically (DOMAIN / INFRASTRUCTURE / WIRING);
// `retryable` is the structured field the retry classifier reads.

const concreteCases: ReadonlyArray<{
	error: () => Error & {
		code: string;
		category: string;
		retryable: boolean;
	};
	code: string;
	category: string;
	retryable: boolean;
}> = [
	{
		error: () =>
			new AggregateNotFoundError({ aggregateType: "Order", id: "o-1" }),
		code: "AGGREGATE_NOT_FOUND",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 1,
				actualVersion: 2,
			}),
		code: "CONCURRENCY_CONFLICT",
		category: "INFRASTRUCTURE",
		retryable: true,
	},
	{
		error: () =>
			new DuplicateAggregateError({
				aggregateType: "Order",
				aggregateId: "o-1",
			}),
		code: "DUPLICATE_AGGREGATE",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new SnapshotSchemaMismatchError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedSchemaVersion: 2,
				actualSchemaVersion: 1,
			}),
		code: "SNAPSHOT_SCHEMA_MISMATCH",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () => new MissingHandlerError("OrderConfirmed"),
		code: "MISSING_HANDLER",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			new NonProgressingEventStreamPageError({
				aggregateType: "Order",
				aggregateId: "o-1",
				fromVersion: 10,
				targetVersion: 12,
			}),
		code: "NON_PROGRESSING_EVENT_STREAM_PAGE",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () => new UnprojectableEventError("orders", "evt-1", "is invalid"),
		code: "UNPROJECTABLE_EVENT",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => new ProjectionGapError("orders", "evt-2", "1:0/1", "3:0/1"),
		code: "PROJECTION_GAP",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new ProjectionOrderViolationError("orders", "evt-1", "3:0/1", "2:0/1"),
		code: "PROJECTION_ORDER_VIOLATION",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new ProjectionIdentityViolationError(
				"orders",
				"evt-new",
				"evt-old",
				"1:0/1",
			),
		code: "PROJECTION_IDENTITY_VIOLATION",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new ProjectionReceiptViolationError("orders", "evt-1", "1:0/1", "1:0/2"),
		code: "PROJECTION_RECEIPT_VIOLATION",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new InMemoryCapacityExceededError({
				store: "InMemoryEventStore",
				resource: "events",
				limit: 2,
				current: 2,
				attempted: 1,
			}),
		code: "IN_MEMORY_CAPACITY_EXCEEDED",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () => new InvalidIntegrationMessageError("$.payload", "is invalid"),
		code: "INVALID_INTEGRATION_MESSAGE",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new UnregisteredHandlerError({
				busKind: "command",
				messageType: "CreateOrder",
			}),
		code: "UNREGISTERED_HANDLER",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			new ErrorMapperFailedError({
				busKind: "command",
				handlerError: new Error("x"),
				mapperError: new Error("y"),
			}),
		code: "ERROR_MAPPER_FAILED",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => new HostileStateKeyError("__proto__"),
		code: "HOSTILE_STATE_KEY",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => new UnreplayableAggregateError("o-1", "it is dirty"),
		code: "UNREPLAYABLE_AGGREGATE",
		category: "WIRING",
		retryable: false,
	},
];

describe("kit errors are StructuredErrors (code = name = the one identifier)", () => {
	it.each(concreteCases.map((c) => [c.code, c] as const))(
		"%s carries code, category, retryable, and name === code",
		(_label, testCase) => {
			const error = testCase.error();

			expect(isStructuredError(error)).toBe(true);
			expect(error.code).toBe(testCase.code);
			expect(error.name).toBe(testCase.code);
			expect(error.category).toBe(testCase.category);
			expect(error.retryable).toBe(testCase.retryable);
		},
	);

	it("typed matchError dispatches exhaustively over kit codes", () => {
		const status = matchError(
			new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 1,
				actualVersion: 2,
			}),
			{
				CONCURRENCY_CONFLICT: () => 409,
				_: () => 500,
			},
		);

		expect(status).toBe(409);
	});

	it("further structured kit errors carry their codes", () => {
		expect(
			new EventHarvestError("event without aggregateId", "OrderConfirmed").code,
		).toBe("EVENT_HARVEST_FAILED");
		expect(new UnenrolledChangesError("o-1").code).toBe("UNENROLLED_CHANGES");
		expect(new AggregateDeletedError("o-1").code).toBe("AGGREGATE_DELETED");
	});
});

describe("consumer-facing abstract bases stay ergonomic", () => {
	it("a DomainError subclass needs only code and message; category and retryable are defaulted", () => {
		class OrderAlreadyShippedError extends DomainError<"ORDER_ALREADY_SHIPPED"> {
			constructor(orderId: string) {
				super({
					code: "ORDER_ALREADY_SHIPPED",
					message: `Order ${orderId} has already been shipped`,
				});
			}
		}

		const error = new OrderAlreadyShippedError("o-1");

		expect(error).toBeInstanceOf(DomainError);
		expect(error.code).toBe("ORDER_ALREADY_SHIPPED");
		expect(error.name).toBe("ORDER_ALREADY_SHIPPED");
		expect(error.category).toBe("DOMAIN");
		expect(error.retryable).toBe(false);
		expect(isStructuredError(error)).toBe(true);
	});

	it("an InfrastructureError subclass can opt into retryable and a cause", () => {
		const cause = new Error("socket closed");
		class DbTimeoutError extends InfrastructureError<"DB_TIMEOUT"> {
			constructor() {
				super({
					code: "DB_TIMEOUT",
					message: "database timed out",
					retryable: true,
					cause,
				});
			}
		}

		const error = new DbTimeoutError();

		expect(error).toBeInstanceOf(InfrastructureError);
		expect(error.category).toBe("INFRASTRUCTURE");
		expect(error.retryable).toBe(true);
		expect(error.cause).toBe(cause);
	});

	it("the hierarchy split survives: DomainError is never an InfrastructureError", () => {
		class SomeDomainError extends DomainError<"SOME_DOMAIN_RULE"> {
			constructor() {
				super({ code: "SOME_DOMAIN_RULE", message: "rule violated" });
			}
		}

		expect(new SomeDomainError()).not.toBeInstanceOf(InfrastructureError);
	});
});

describe("the no-base-error consumer path is first-class", () => {
	// Deliberately NO import from @shirudo/base-error in this block: a
	// consumer that never adopts base-error branches on plain fields and
	// kit-exported bases only. base-error's toolbox (matchError, catalogs,
	// toProblem) is an on-top benefit, never a prerequisite.
	it("branches with a plain switch on error.code and plain property reads", () => {
		const error: unknown = new ConcurrencyConflictError({
			aggregateType: "Order",
			aggregateId: "o-1",
			expectedVersion: 1,
			actualVersion: 2,
		});

		let status = 500;
		let retry = false;
		if (error instanceof InfrastructureError) {
			switch (error.code) {
				case "CONCURRENCY_CONFLICT":
					status = 409;
					retry = error.retryable;
					break;
				case "AGGREGATE_NOT_FOUND":
					status = 404;
					break;
			}
		}

		expect(status).toBe(409);
		expect(retry).toBe(true);
	});
});

describe("KitErrorCode stays in sync with the classes", () => {
	it("every concrete kit error code is a member of the union (compile-time)", () => {
		// Type-level completeness check: a class code missing from the
		// hand-maintained KitErrorCode union fails compilation here.
		type AssertKitCode<T extends KitErrorCode> = T;
		type _Checks = [
			AssertKitCode<AggregateDeletedError["code"]>,
			AssertKitCode<AggregateNotFoundError["code"]>,
			AssertKitCode<ConcurrencyConflictError["code"]>,
			AssertKitCode<DuplicateAggregateError["code"]>,
			AssertKitCode<ErrorMapperFailedError["code"]>,
			AssertKitCode<EventHarvestError["code"]>,
			AssertKitCode<HostileStateKeyError["code"]>,
			AssertKitCode<InMemoryCapacityExceededError["code"]>,
			AssertKitCode<InvalidIntegrationMessageError["code"]>,
			AssertKitCode<MissingHandlerError["code"]>,
			AssertKitCode<NonProgressingEventStreamPageError["code"]>,
			AssertKitCode<ProjectionGapError["code"]>,
			AssertKitCode<ProjectionIdentityViolationError["code"]>,
			AssertKitCode<ProjectionOrderViolationError["code"]>,
			AssertKitCode<ProjectionReceiptViolationError["code"]>,
			AssertKitCode<SnapshotSchemaMismatchError["code"]>,
			AssertKitCode<UnenrolledChangesError["code"]>,
			AssertKitCode<UnprojectableEventError["code"]>,
			AssertKitCode<UnregisteredHandlerError["code"]>,
			AssertKitCode<UnreplayableAggregateError["code"]>,
		];
		const witness: _Checks | undefined = undefined;
		expect(witness).toBeUndefined();
	});
});
