import { isStructuredError, matchError } from "@shirudo/base-error";
import { describe, expect, it } from "vite-plus/test";
import {
	invalidFlushStatementError,
	RollbackError,
} from "../application/unit-of-work/errors";
import type { AggregateWriteIntent } from "../application/unit-of-work/persistence-contract";
import type { AggregateIdentity } from "../domain/aggregate/aggregate-identity";
import { InvalidDomainTransitionError } from "../domain/state-machine/errors";
import {
	AcknowledgedRecordPendingError,
	type AggregateDeletedErrorOptions,
	type AggregateIdentityMismatchOptions,
	AggregateNotFoundError,
	type AggregateNotFoundErrorOptions,
	aggregateDeletedError,
	ConcurrencyConflictError,
	type ConcurrencyConflictErrorOptions,
	type DirectStateMutationErrorOptions,
	DomainError,
	DuplicateAggregateError,
	type DuplicateAggregateErrorOptions,
	type DuplicateEventIdErrorOptions,
	directStateMutationError,
	duplicateKitCopyError,
	errorMapperFailedError,
	eventCollectionError,
	ForeignEventError,
	foldReturnedNoStateError,
	InfrastructureError,
	InMemoryCapacityExceededError,
	InvalidCommandMessageError,
	InvalidEventStreamPageError,
	type InvalidEventStreamPageErrorOptions,
	InvalidIntegrationMessageError,
	invalidVersionError,
	type KitErrorCode,
	KitWiringError,
	misattributedEventError,
	missingEntityIdError,
	missingFoldError,
	missingHandlerError,
	type PendingEventBatchMismatchErrorOptions,
	type PendingEventLimitExceededErrorOptions,
	ProjectionGapError,
	ProjectionIdentityViolationError,
	ProjectionOrderViolationError,
	ProjectionReceiptViolationError,
	pendingEventBatchMismatchError,
	pendingEventLimitExceededError,
	prototypePollutionError,
	type ReentrantEventRecordingErrorOptions,
	ReplayRejectedError,
	type ReplayRejectedErrorOptions,
	ReplayTargetMismatchError,
	type ReplayTargetMismatchErrorOptions,
	SnapshotSchemaMismatchError,
	type SnapshotSchemaMismatchErrorOptions,
	type SnapshotVersionNotRestoredErrorOptions,
	snapshotVersionNotRestoredError,
	type UnregisteredChangesErrorOptions,
	type UnreplayableAggregateErrorOptions,
	unmanagedInstanceError,
	unprojectableEventError,
	unregisteredChangesError,
	unregisteredHandlerError,
	unreplayableAggregateError,
} from "./kit-errors";

// The structured-error contract for every kit error (decided 2026-07-05):
// kit errors ARE StructuredErrors. `code` is THE identifier (SCREAMING_SNAKE,
// matchError, catalogs, wire) and `name === code` by base-error's design, so
// there is exactly one identifier and no name/code drift. `category` follows
// the class hierarchy mechanically (DOMAIN / INFRASTRUCTURE / WIRING);
// `retryable` is the structured field the retry classifier reads.

class RowRejectedError extends DomainError<"ROW_REJECTED"> {
	constructor() {
		super({ code: "ROW_REJECTED", message: "the fold rejects this row" });
	}
}

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
			new AggregateNotFoundError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
			}),
		code: "AGGREGATE_NOT_FOUND",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new ConcurrencyConflictError({
				reason: "stale_version",
				identity: { aggregateType: "Order", aggregateId: "o-1" },
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
				identity: { aggregateType: "Order", aggregateId: "o-1" },
			}),
		code: "DUPLICATE_AGGREGATE",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new SnapshotSchemaMismatchError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
				expectedSchemaVersion: 2,
				actualSchemaVersion: 1,
			}),
		code: "SNAPSHOT_SCHEMA_MISMATCH",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			snapshotVersionNotRestoredError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
				snapshotVersion: 7,
				restoredVersion: 0,
			}),
		code: "SNAPSHOT_VERSION_NOT_RESTORED",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => missingHandlerError("OrderConfirmed"),
		code: "MISSING_HANDLER",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			misattributedEventError({
				expected: { aggregateType: "Order", aggregateId: "o-1" },
				actual: { aggregateId: "o-2" },
				eventType: "OrderConfirmed",
			}),
		code: "MISATTRIBUTED_EVENT",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => missingFoldError("OrderConfirmed"),
		code: "MISSING_FOLD",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => foldReturnedNoStateError("OrderConfirmed"),
		code: "FOLD_RETURNED_NO_STATE",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			directStateMutationError({
				identity: { aggregateType: "Order", aggregateId: "order-1" },
			}),
		code: "DIRECT_STATE_MUTATION",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => missingEntityIdError(undefined),
		code: "MISSING_ENTITY_ID",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			pendingEventBatchMismatchError({
				identity: { aggregateType: "Order", aggregateId: "order-1" },
				batchLength: 2,
				pendingLength: 1,
			}),
		code: "PENDING_EVENT_BATCH_MISMATCH",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			pendingEventLimitExceededError({
				identity: { aggregateType: "Order", aggregateId: "order-1" },
				limit: 2,
				pending: 2,
				added: 1,
			}),
		code: "PENDING_EVENT_LIMIT_EXCEEDED",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			unmanagedInstanceError("stampPendingEvents", "aggregate", "order-1"),
		code: "UNMANAGED_INSTANCE",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => duplicateKitCopyError("The aggregate"),
		code: "DUPLICATE_KIT_COPY",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => invalidVersionError(-1, "is not a safe integer"),
		code: "INVALID_VERSION",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			new ForeignEventError({
				expected: { aggregateType: "Order", aggregateId: "o-1" },
				actual: { aggregateType: "Invoice", aggregateId: "o-1" },
				eventType: "OrderConfirmed",
			}),
		code: "FOREIGN_EVENT",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new InvalidEventStreamPageError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
				reason: "empty_page",
				fromVersion: 10,
				targetVersion: 12,
			}),
		code: "INVALID_EVENT_STREAM_PAGE",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new ReplayTargetMismatchError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
				reason: "pages_short_of_target",
				fromVersion: 10,
				targetVersion: 12,
				actualVersion: 11,
			}),
		code: "REPLAY_TARGET_MISMATCH",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () =>
			new ReplayRejectedError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
				fromVersion: 10,
				toVersion: 12,
				cause: new RowRejectedError(),
			}),
		code: "REPLAY_REJECTED",
		category: "INFRASTRUCTURE",
		retryable: false,
	},
	{
		error: () => unprojectableEventError("orders", "evt-1", "is invalid"),
		code: "UNPROJECTABLE_EVENT",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => new AcknowledgedRecordPendingError("evt-1"),
		code: "ACKNOWLEDGED_RECORD_PENDING",
		category: "INFRASTRUCTURE",
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
		error: () =>
			new InvalidCommandMessageError("$.command.payload", "is invalid"),
		code: "INVALID_COMMAND_MESSAGE",
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
			unregisteredHandlerError({
				busKind: "command",
				messageType: "CreateOrder",
			}),
		code: "UNREGISTERED_HANDLER",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			errorMapperFailedError({
				busKind: "command",
				handlerError: new Error("x"),
				mapperError: new Error("y"),
			}),
		code: "ERROR_MAPPER_FAILED",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () => prototypePollutionError("__proto__"),
		code: "PROTOTYPE_POLLUTION",
		category: "WIRING",
		retryable: false,
	},
	{
		error: () =>
			unreplayableAggregateError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
				reason: "it is dirty",
			}),
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
				reason: "stale_version",
				identity: { aggregateType: "Order", aggregateId: "o-1" },
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
			eventCollectionError("event without aggregateId", "OrderConfirmed").code,
		).toBe("EVENT_COLLECTION_FAILED");
		expect(
			unregisteredChangesError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
			}).code,
		).toBe("UNREGISTERED_CHANGES");
		expect(
			aggregateDeletedError({
				identity: { aggregateType: "Order", aggregateId: "o-1" },
			}).code,
		).toBe("AGGREGATE_DELETED");
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
			reason: "stale_version",
			identity: { aggregateType: "Order", aggregateId: "o-1" },
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

describe("a serialized kit error keeps the fields it declares", () => {
	it("carries the fields of an infrastructure error", () => {
		const error = new ConcurrencyConflictError({
			reason: "stale_version",
			identity: { aggregateType: "Order", aggregateId: "order-1" },
			expectedVersion: 3,
			actualVersion: 5,
		});

		expect(JSON.parse(JSON.stringify(error))).toMatchObject({
			code: "CONCURRENCY_CONFLICT",
			category: "INFRASTRUCTURE",
			retryable: true,
			identity: { aggregateType: "Order", aggregateId: "order-1" },
			expectedVersion: 3,
			actualVersion: 5,
		});
	});

	it("carries the fields of a wiring error", () => {
		const error = invalidFlushStatementError({
			identity: { aggregateType: "Order", aggregateId: "order-1" },
			intent: "update",
			reason: "no_row_count",
			received: "1 (bigint)",
		});

		expect(JSON.parse(JSON.stringify(error))).toMatchObject({
			code: "INVALID_FLUSH_STATEMENT",
			category: "WIRING",
			retryable: false,
			details: {
				intent: "update",
				reason: "no_row_count",
				received: "1 (bigint)",
			},
		});
	});

	it("carries the fields of a domain error", () => {
		const error = new InvalidDomainTransitionError("draft", "ship");

		expect(JSON.parse(JSON.stringify(error))).toMatchObject({
			code: "INVALID_DOMAIN_TRANSITION",
			category: "DOMAIN",
			retryable: false,
			state: "draft",
			inputType: "ship",
		});
	});

	it("survives a field that holds a value with a cycle", () => {
		const driver: Record<string, unknown> = { name: "DriverError" };
		driver.connection = { pool: driver };
		const error = new RollbackError(new Error("callback failed"), driver);

		expect(() => JSON.stringify(error)).not.toThrow();
		expect(JSON.parse(JSON.stringify(error))).toMatchObject({
			code: "ROLLBACK_FAILED",
		});
	});

	it("keeps name, message and code of a field that holds an error", () => {
		const rollbackCause = aggregateDeletedError({
			identity: { aggregateType: "Order", aggregateId: "order-1" },
		});
		const error = new RollbackError(
			new Error("callback failed"),
			rollbackCause,
		);

		expect(JSON.parse(JSON.stringify(error))).toMatchObject({
			rollbackCause: {
				name: "AGGREGATE_DELETED",
				code: "AGGREGATE_DELETED",
			},
		});
	});

	it("leaves the internals of the envelope out", () => {
		const error = new ConcurrencyConflictError({
			identity: { aggregateType: "Order", aggregateId: "order-1" },
			expectedVersion: 3,
			reason: "stale_version",
			actualVersion: 5,
		});

		const serialized = JSON.parse(JSON.stringify(error)) as Record<
			string,
			unknown
		>;

		expect(serialized._tag).toBeUndefined();
		expect("details" in serialized).toBe(false);
	});

	it("does not let a declared field overwrite the envelope", () => {
		const error = new ConcurrencyConflictError({
			reason: "stale_version",
			identity: { aggregateType: "Order", aggregateId: "order-1" },
			expectedVersion: 3,
			actualVersion: 5,
		});

		const serialized = JSON.parse(JSON.stringify(error)) as {
			name: string;
			code: string;
		};

		expect(serialized.name).toBe("CONCURRENCY_CONFLICT");
		expect(serialized.code).toBe("CONCURRENCY_CONFLICT");
	});
});

describe("KitErrorCode stays in sync with the classes", () => {
	it("every concrete kit error code is a member of the union (compile-time)", () => {
		// Type-level completeness check: a class code missing from the
		// hand-maintained KitErrorCode union fails compilation here.
		type AssertKitCode<T extends KitErrorCode> = T;
		type _Checks = [
			AssertKitCode<AcknowledgedRecordPendingError["code"]>,
			AssertKitCode<KitWiringError<"AGGREGATE_DELETED">["code"]>,
			AssertKitCode<AggregateNotFoundError["code"]>,
			AssertKitCode<KitWiringError<"DUPLICATE_KIT_COPY">["code"]>,
			AssertKitCode<ConcurrencyConflictError["code"]>,
			AssertKitCode<KitWiringError<"DIRECT_STATE_MUTATION">["code"]>,
			AssertKitCode<DuplicateAggregateError["code"]>,
			AssertKitCode<KitWiringError<"ERROR_MAPPER_FAILED">["code"]>,
			AssertKitCode<KitWiringError<"EVENT_COLLECTION_FAILED">["code"]>,
			AssertKitCode<KitWiringError<"FOLD_RETURNED_NO_STATE">["code"]>,
			AssertKitCode<ForeignEventError["code"]>,
			AssertKitCode<KitWiringError<"PROTOTYPE_POLLUTION">["code"]>,
			AssertKitCode<InMemoryCapacityExceededError["code"]>,
			AssertKitCode<InvalidCommandMessageError["code"]>,
			AssertKitCode<InvalidIntegrationMessageError["code"]>,
			AssertKitCode<KitWiringError<"INVALID_VERSION">["code"]>,
			AssertKitCode<KitWiringError<"MISATTRIBUTED_EVENT">["code"]>,
			AssertKitCode<KitWiringError<"MISSING_ENTITY_ID">["code"]>,
			AssertKitCode<KitWiringError<"MISSING_FOLD">["code"]>,
			AssertKitCode<KitWiringError<"MISSING_HANDLER">["code"]>,
			AssertKitCode<InvalidEventStreamPageError["code"]>,
			AssertKitCode<ReplayTargetMismatchError["code"]>,
			AssertKitCode<ReplayRejectedError["code"]>,
			AssertKitCode<KitWiringError<"PENDING_EVENT_BATCH_MISMATCH">["code"]>,
			AssertKitCode<KitWiringError<"PENDING_EVENT_LIMIT_EXCEEDED">["code"]>,
			AssertKitCode<ProjectionGapError["code"]>,
			AssertKitCode<KitWiringError<"EVENT_BUS_CLOSED">["code"]>,
			AssertKitCode<KitWiringError<"PUBLISH_DEPTH_EXCEEDED">["code"]>,
			AssertKitCode<ProjectionIdentityViolationError["code"]>,
			AssertKitCode<ProjectionOrderViolationError["code"]>,
			AssertKitCode<ProjectionReceiptViolationError["code"]>,
			AssertKitCode<SnapshotSchemaMismatchError["code"]>,
			AssertKitCode<KitWiringError<"SNAPSHOT_VERSION_NOT_RESTORED">["code"]>,
			AssertKitCode<KitWiringError<"UNREGISTERED_CHANGES">["code"]>,
			AssertKitCode<KitWiringError<"UNMANAGED_INSTANCE">["code"]>,
			AssertKitCode<KitWiringError<"UNPROJECTABLE_EVENT">["code"]>,
			AssertKitCode<KitWiringError<"UNREGISTERED_HANDLER">["code"]>,
			AssertKitCode<KitWiringError<"UNREPLAYABLE_AGGREGATE">["code"]>,
		];
		const witness: _Checks | undefined = undefined;
		expect(witness).toBeUndefined();
	});
});

describe("an error that names an aggregate keeps its own copy of the identity", () => {
	class RowRejected extends DomainError<"ROW_REJECTED"> {
		constructor() {
			super({ code: "ROW_REJECTED", message: "the fold rejects this row" });
		}
	}

	const identityCarriers: ReadonlyArray<{
		name: string;
		build: (identity: { aggregateType: string; aggregateId: string }) => object;
	}> = [
		{
			name: "ConcurrencyConflictError",
			build: (identity) =>
				new ConcurrencyConflictError({
					identity,
					expectedVersion: 1,
					reason: "stale_version",
					actualVersion: 2,
				}),
		},
		{
			name: "DuplicateAggregateError",
			build: (identity) => new DuplicateAggregateError({ identity }),
		},
		{
			name: "AggregateNotFoundError",
			build: (identity) => new AggregateNotFoundError({ identity }),
		},
		{
			name: "SnapshotSchemaMismatchError",
			build: (identity) =>
				new SnapshotSchemaMismatchError({
					identity,
					expectedSchemaVersion: 2,
					actualSchemaVersion: 1,
				}),
		},
		{
			name: "SNAPSHOT_VERSION_NOT_RESTORED",
			build: (identity) =>
				snapshotVersionNotRestoredError({
					identity,
					snapshotVersion: 3,
					restoredVersion: 0,
				}),
		},
		{
			name: "PENDING_EVENT_LIMIT_EXCEEDED",
			build: (identity) =>
				pendingEventLimitExceededError({
					identity,
					limit: 1,
					pending: 1,
					added: 1,
				}),
		},
		{
			name: "INVALID_FLUSH_STATEMENT",
			build: (identity) =>
				invalidFlushStatementError({
					identity,
					intent: "update",
					reason: "no_row_count",
				}),
		},
		{
			name: "InvalidEventStreamPageError",
			build: (identity) =>
				new InvalidEventStreamPageError({
					identity,
					reason: "empty_page",
					fromVersion: 0,
					targetVersion: 1,
				}),
		},
		{
			name: "ReplayTargetMismatchError",
			build: (identity) =>
				new ReplayTargetMismatchError({
					identity,
					reason: "pages_short_of_target",
					fromVersion: 0,
					targetVersion: 2,
					actualVersion: 1,
				}),
		},
		{
			name: "ReplayRejectedError",
			build: (identity) =>
				new ReplayRejectedError({
					identity,
					fromVersion: 0,
					toVersion: 1,
					cause: new RowRejected(),
				}),
		},
	];

	it.each(identityCarriers)(
		"$name holds a frozen copy of the two aggregate identity fields",
		({ build }) => {
			const identity = {
				aggregateType: "Order",
				aggregateId: "o-1",
				extra: "x",
			};

			const error = build(identity);
			identity.aggregateId = "o-2";
			const carried =
				error instanceof KitWiringError
					? error.details.identity
					: (error as { readonly identity: unknown }).identity;

			expect(carried).toStrictEqual({
				aggregateType: "Order",
				aggregateId: "o-1",
			});
			expect(Object.isFrozen(carried)).toBe(true);
		},
	);

	it("MISATTRIBUTED_EVENT holds frozen copies of the expected and the actual identity", () => {
		const expected = {
			aggregateType: "Order",
			aggregateId: "o-1",
			extra: "x",
		};
		const actual = { aggregateId: "o-2" };

		const error = misattributedEventError({
			expected,
			actual,
			eventType: "OrderPlaced",
		});
		expected.aggregateId = "changed";
		actual.aggregateId = "changed";

		expect(error.details.expected).toStrictEqual({
			aggregateType: "Order",
			aggregateId: "o-1",
		});
		expect(error.details.actual).toStrictEqual({ aggregateId: "o-2" });
		expect(Object.isFrozen(error.details.expected)).toBe(true);
		expect(Object.isFrozen(error.details.actual)).toBe(true);
	});

	it.each([["ForeignEventError", ForeignEventError]] as const)(
		"%s holds frozen copies of the expected and the actual identity",
		(_, ErrorClass) => {
			const expected = {
				aggregateType: "Order",
				aggregateId: "o-1",
				extra: "x",
			};
			const actual = { aggregateId: "o-2" };

			const error = new ErrorClass({
				expected,
				actual,
				eventType: "OrderPlaced",
			});
			expected.aggregateId = "changed";
			actual.aggregateId = "changed";

			expect(error.expected).toStrictEqual({
				aggregateType: "Order",
				aggregateId: "o-1",
			});
			expect(error.actual).toStrictEqual({ aggregateId: "o-2" });
			expect(Object.isFrozen(error.expected)).toBe(true);
			expect(Object.isFrozen(error.actual)).toBe(true);
		},
	);
});

// The errors area imports nothing from the kit, so its options types
// declare the identity shape inline. This pins every copy to
// AggregateIdentity: a lost readonly or an extra field breaks the typecheck.
type SameType<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

const identityShapesMatchAggregateIdentity: [
	SameType<ConcurrencyConflictErrorOptions["identity"], AggregateIdentity>,
	SameType<DuplicateAggregateErrorOptions["identity"], AggregateIdentity>,
	SameType<AggregateNotFoundErrorOptions["identity"], AggregateIdentity>,
	SameType<SnapshotSchemaMismatchErrorOptions["identity"], AggregateIdentity>,
	SameType<
		SnapshotVersionNotRestoredErrorOptions["identity"],
		AggregateIdentity
	>,
	SameType<
		PendingEventLimitExceededErrorOptions["identity"],
		AggregateIdentity
	>,
	SameType<InvalidEventStreamPageErrorOptions["identity"], AggregateIdentity>,
	SameType<ReplayTargetMismatchErrorOptions["identity"], AggregateIdentity>,
	SameType<ReplayRejectedErrorOptions["identity"], AggregateIdentity>,
	SameType<AggregateIdentityMismatchOptions["expected"], AggregateIdentity>,
	SameType<DirectStateMutationErrorOptions["identity"], AggregateIdentity>,
	SameType<UnreplayableAggregateErrorOptions["identity"], AggregateIdentity>,
	SameType<
		PendingEventBatchMismatchErrorOptions["identity"],
		AggregateIdentity
	>,
	SameType<UnregisteredChangesErrorOptions["identity"], AggregateIdentity>,
	SameType<AggregateDeletedErrorOptions["identity"], AggregateIdentity>,
	SameType<ReentrantEventRecordingErrorOptions["identity"], AggregateIdentity>,
	SameType<DuplicateEventIdErrorOptions["identity"], AggregateIdentity>,
] = [
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
];

it("pins every inline identity shape to AggregateIdentity", () => {
	expect(identityShapesMatchAggregateIdentity.every(Boolean)).toBe(true);
});

// The conflict declares its intent inline for the same reason.
const conflictIntentMatchesWriteIntent: SameType<
	NonNullable<ConcurrencyConflictErrorOptions["intent"]>,
	AggregateWriteIntent
> = true;

it("pins the inline conflict intent to the write intents", () => {
	expect(conflictIntentMatchesWriteIntent).toBe(true);
});
