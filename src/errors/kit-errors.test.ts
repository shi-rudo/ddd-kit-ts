import {
	findInCauseChain,
	getRootCause,
	isBaseError,
	isRetryable,
} from "@shirudo/base-error";
import { describe, expect, it } from "vite-plus/test";
import {
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DomainError,
	DuplicateAggregateError,
	EventHarvestError,
	InfrastructureError,
	InvalidEventStreamPageError,
	MissingFoldError,
	MissingHandlerError,
	ReplayRejectedError,
	UnenrolledChangesError,
	UnreplayableAggregateError,
} from "./kit-errors";

describe("InvalidEventStreamPageError", () => {
	const stream = { aggregateType: "Order", aggregateId: "order-1" };

	it("is a non-retryable infrastructure error with one code for every reason", () => {
		const error = new InvalidEventStreamPageError({
			...stream,
			reason: "empty_page",
			fromVersion: 256,
			targetVersion: 300,
		});

		expect(error.code).toBe("INVALID_EVENT_STREAM_PAGE");
		expect(error.name).toBe("INVALID_EVENT_STREAM_PAGE");
		expect(error).toBeInstanceOf(InfrastructureError);
		expect(error.category).toBe("INFRASTRUCTURE");
		expect(error.retryable).toBe(false);
		expect(error).toMatchObject({
			...stream,
			reason: "empty_page",
			fromVersion: 256,
			targetVersion: 300,
		});
	});

	it("names an empty page with its cursor and target version", () => {
		const error = new InvalidEventStreamPageError({
			...stream,
			reason: "empty_page",
			fromVersion: 256,
			targetVersion: 300,
		});

		expect(error.message).toContain("Order(order-1)");
		expect(error.message).toContain("empty page after version 256");
		expect(error.message).toContain("target version 300");
	});

	it("names a vanished stream with its cursor and target version", () => {
		const error = new InvalidEventStreamPageError({
			...stream,
			reason: "stream_vanished",
			fromVersion: 256,
			targetVersion: 300,
		});

		expect(error.message).toContain("absent after version 256");
		expect(error.message).toContain("target version 300");
	});

	it("names a page past the target with its size and the room left", () => {
		const error = new InvalidEventStreamPageError({
			...stream,
			reason: "page_past_target",
			fromVersion: 298,
			targetVersion: 300,
			eventCount: 5,
		});

		expect(error.eventCount).toBe(5);
		expect(error.message).toContain("5 events after version 298");
		expect(error.message).toContain("(298, 300]");
	});

	it("names a regressed head with both heads", () => {
		const error = new InvalidEventStreamPageError({
			...stream,
			reason: "head_regressed",
			fromVersion: 256,
			targetVersion: 300,
			lastVersion: 280,
			firstPageLastVersion: 300,
		});

		expect(error.lastVersion).toBe(280);
		expect(error.firstPageLastVersion).toBe(300);
		expect(error.message).toContain("head 280");
		expect(error.message).toContain("head 300 of the first page");
	});

	it("names a head below 1 and pins no target version on the first page", () => {
		const error = new InvalidEventStreamPageError({
			...stream,
			reason: "invalid_head",
			fromVersion: 0,
			lastVersion: 0,
		});

		expect(error.targetVersion).toBeUndefined();
		expect(error.message).toContain("head 0");
		expect(error.message).toContain("report a stream without events as absent");
	});

	it("names the type of a head that is not a number", () => {
		const error = new InvalidEventStreamPageError({
			...stream,
			reason: "invalid_head",
			fromVersion: 0,
			lastVersion: "5",
		});

		expect(error.lastVersion).toBe("5");
		expect(error.message).toContain('head "5" of type string');
	});
});

describe("ReplayRejectedError", () => {
	class RowRejectedError extends DomainError<"ROW_REJECTED"> {
		constructor() {
			super({ code: "ROW_REJECTED", message: "the fold rejects this row" });
		}
	}

	it("carries the stream, the window of the rejected page, and the domain error as cause", () => {
		const cause = new RowRejectedError();
		const error = new ReplayRejectedError({
			aggregateType: "Order",
			aggregateId: "order-1",
			fromVersion: 256,
			toVersion: 300,
			cause,
		});

		expect(error.code).toBe("REPLAY_REJECTED");
		expect(error.name).toBe("REPLAY_REJECTED");
		expect(error).toBeInstanceOf(InfrastructureError);
		expect(error.retryable).toBe(false);
		expect(error).toMatchObject({
			aggregateType: "Order",
			aggregateId: "order-1",
			fromVersion: 256,
			toVersion: 300,
		});
		expect(error.cause).toBe(cause);
		expect(error.message).toContain("Order(order-1)");
		expect(error.message).toContain("(256, 300]");
		expect(error.message).toContain("ROW_REJECTED");
	});

	it("names a rejected empty history when the window is empty", () => {
		const error = new ReplayRejectedError({
			aggregateType: "Order",
			aggregateId: "order-1",
			fromVersion: 4,
			toVersion: 4,
			cause: new RowRejectedError(),
		});

		expect(error.message).toContain("rejected an empty history at version 4");
	});
});

describe("DomainError", () => {
	it("is abstract; only consumer subclasses are constructible", () => {
		class OrderAlreadyShippedError extends DomainError<"ORDER_ALREADY_SHIPPED"> {
			constructor(orderId: string) {
				super({
					code: "ORDER_ALREADY_SHIPPED",
					message: `Order ${orderId} is already shipped`,
				});
			}
		}

		const e = new OrderAlreadyShippedError("o-1");
		expect(e).toBeInstanceOf(DomainError);
		expect(e.name).toBe("ORDER_ALREADY_SHIPPED");
		expect(e.message).toBe("Order o-1 is already shipped");
	});

	it("is not an InfrastructureError, so App-layer catches stay separable", () => {
		class OrderError extends DomainError<"ORDER_ERROR"> {
			constructor() {
				super({ code: "ORDER_ERROR", message: "nope" });
			}
		}
		expect(new OrderError()).not.toBeInstanceOf(InfrastructureError);
	});

	it("inherits BaseError surface: timestamp, isBaseError detection", () => {
		class OrderError extends DomainError<"ORDER_ERROR"> {
			constructor() {
				super({ code: "ORDER_ERROR", message: "nope" });
			}
		}
		const before = Date.now();
		const e = new OrderError();
		const after = Date.now();

		expect(isBaseError(e)).toBe(true);
		expect(e.timestamp).toBeGreaterThanOrEqual(before);
		expect(e.timestamp).toBeLessThanOrEqual(after);
		expect(typeof e.timestampIso).toBe("string");
	});

	it("propagates cause through the BaseError chain", () => {
		class OrderError extends DomainError<"ORDER_ERROR"> {
			constructor(cause: unknown) {
				super({ code: "ORDER_ERROR", message: "wrapped", cause });
			}
		}
		const root = new Error("driver-level failure");
		const wrapped = new OrderError(root);

		expect(getRootCause(wrapped)).toBe(root);
		expect(findInCauseChain(wrapped, (e) => e === root)).toBe(root);
	});
});

describe("InfrastructureError", () => {
	it("is not a DomainError: distinct hierarchy from business-rule violations", () => {
		class DriverTimeout extends InfrastructureError<"DRIVER_TIMEOUT"> {
			constructor() {
				super({ code: "DRIVER_TIMEOUT", message: "timeout" });
			}
		}
		const e = new DriverTimeout();
		expect(e).toBeInstanceOf(InfrastructureError);
		expect(e).not.toBeInstanceOf(DomainError);
		expect(isBaseError(e)).toBe(true);
	});
});

describe("MissingHandlerError", () => {
	it("is intentionally neither a DomainError nor an InfrastructureError", () => {
		// `catch (e instanceof DomainError)` at the App layer must NOT
		// swallow a forgotten projection handler: that's a programming bug
		// that should crash loud during development.
		const e = new MissingHandlerError("OrderShipped");
		expect(e).not.toBeInstanceOf(DomainError);
		expect(e).not.toBeInstanceOf(InfrastructureError);
		expect(isBaseError(e)).toBe(true);
		expect(e.name).toBe("MISSING_HANDLER");
		expect(e.eventType).toBe("OrderShipped");
		expect(e.message).toContain("OrderShipped");
	});

	it("accepts a cause and preserves it in the chain", () => {
		const root = new Error("registry lookup failed");
		const e = new MissingHandlerError("OrderShipped", root);
		expect(getRootCause(e)).toBe(root);
	});
});

describe("MissingFoldError", () => {
	it("is intentionally neither a DomainError nor an InfrastructureError", () => {
		// `catch (e instanceof DomainError)` at the App layer must NOT
		// swallow a forgotten fold: that's a programming bug that should
		// crash loud during development.
		const e = new MissingFoldError("OrderShipped");
		expect(e).not.toBeInstanceOf(DomainError);
		expect(e).not.toBeInstanceOf(InfrastructureError);
		expect(isBaseError(e)).toBe(true);
		expect(e.name).toBe("MISSING_FOLD");
		expect(e.eventType).toBe("OrderShipped");
		expect(e.message).toContain("OrderShipped");
	});

	it("accepts a cause and preserves it in the chain", () => {
		const root = new Error("registry lookup failed");
		const e = new MissingFoldError("OrderShipped", root);
		expect(getRootCause(e)).toBe(root);
	});
});

describe("UnreplayableAggregateError", () => {
	it("keeps the class message focused on fresh-instance reconstitution", () => {
		// Replay guards can add context while the class keeps the safe common
		// remedy: discard the dirty target and reconstitute a fresh instance.
		const error = new UnreplayableAggregateError(
			"agg-1",
			"it carries 2 unflushed pending event(s)",
		);

		expect(error.message).not.toContain("markPersisted");
		expect(error.message).not.toContain("clearPendingEvents");
		expect(error.message).toContain("Reconstitute on a fresh instance");
	});
});

describe("AggregateNotFoundError", () => {
	it("carries aggregate type and id in the technical message", () => {
		const e = new AggregateNotFoundError({ aggregateType: "Order", id: "o-1" });
		expect(e.aggregateType).toBe("Order");
		expect(e.id).toBe("o-1");
		expect(e.message).toContain("Order(o-1)"); // technical
	});

	it("is NOT retryable: the row isn't there; retry won't help", () => {
		expect(
			isRetryable(
				new AggregateNotFoundError({ aggregateType: "Order", id: "o-1" }),
			),
		).toBe(false);
	});

	it("preserves a wrapped driver error via cause", () => {
		const driverErr = new Error("postgres: no rows in result set");
		const e = new AggregateNotFoundError({
			aggregateType: "Order",
			id: "o-1",
			cause: driverErr,
		});
		expect(getRootCause(e)).toBe(driverErr);
	});
});

describe("DuplicateAggregateError", () => {
	it("carries aggregate type and id in the technical message", () => {
		const e = new DuplicateAggregateError({
			aggregateType: "Order",
			aggregateId: "o-1",
		});
		expect(e.aggregateType).toBe("Order");
		expect(e.aggregateId).toBe("o-1");
		expect(e.name).toBe("DUPLICATE_AGGREGATE");
		expect(e.message).toContain("Order(o-1)"); // technical
	});

	it("is an InfrastructureError and NOT retryable: re-running the same INSERT cannot succeed", () => {
		const e = new DuplicateAggregateError({
			aggregateType: "Order",
			aggregateId: "o-1",
		});
		expect(e).toBeInstanceOf(InfrastructureError);
		expect(isRetryable(e)).toBe(false);
	});

	it("preserves the wrapped driver error via cause", () => {
		const driverErr = Object.assign(new Error("duplicate key value"), {
			code: "23505",
		});
		const e = new DuplicateAggregateError({
			aggregateType: "Order",
			aggregateId: "o-1",
			cause: driverErr,
		});
		expect(getRootCause(e)).toBe(driverErr);
	});
});

describe("ConcurrencyConflictError", () => {
	it("carries expected/actual versions for OCC reporting", () => {
		const e = new ConcurrencyConflictError({
			reason: "stale_version",
			aggregateType: "Order",
			aggregateId: "o-1",
			expectedVersion: 3,
			actualVersion: 5,
		});
		expect(e.aggregateType).toBe("Order");
		expect(e.aggregateId).toBe("o-1");
		expect(e.expectedVersion).toBe(3);
		expect(e.actualVersion).toBe(5);
		expect(e.message).toContain("expected version 3");
		expect(e.message).toContain("stored version 5");
	});

	it("marks itself retryable so isRetryable picks it up: the OCC reload-and-retry pattern", () => {
		const e = new ConcurrencyConflictError({
			reason: "stale_version",
			aggregateType: "Order",
			aggregateId: "o-1",
			expectedVersion: 3,
			actualVersion: 5,
		});
		expect(e.retryable).toBe(true);
		expect(isRetryable(e)).toBe(true);
	});

	it("retryable hint survives wrapping in a use-case-level DomainError", () => {
		class FailedToConfirmOrderError extends DomainError<"FAILED_TO_CONFIRM_ORDER"> {
			constructor(cause: unknown) {
				super({
					code: "FAILED_TO_CONFIRM_ORDER",
					message: "Failed to confirm order",
					cause,
				});
			}
		}
		const root = new ConcurrencyConflictError({
			reason: "stale_version",
			aggregateType: "Order",
			aggregateId: "o-1",
			expectedVersion: 3,
			actualVersion: 5,
		});
		const wrapped = new FailedToConfirmOrderError(root);

		// The cause-chain helpers find the retryable root; an App-Service
		// orchestrator inspecting the root can decide to retry.
		expect(getRootCause(wrapped)).toBe(root);
		expect(isRetryable(getRootCause(wrapped))).toBe(true);
	});

	it("serialises to JSON with name, message, and timestamp for structured logging", () => {
		const e = new ConcurrencyConflictError({
			reason: "stale_version",
			aggregateType: "Order",
			aggregateId: "o-1",
			expectedVersion: 3,
			actualVersion: 5,
		});
		const json = e.toJSON();
		expect(json.name).toBe("CONCURRENCY_CONFLICT");
		expect(json.message).toContain("Order(o-1)");
		expect(json.timestamp).toBeDefined();
	});
});

describe("EventHarvestError", () => {
	it("is a BaseError but NOT an InfrastructureError (deterministic, not retryable)", () => {
		const e = new EventHarvestError("bad event");
		expect(isBaseError(e)).toBe(true);
		expect(e).not.toBeInstanceOf(InfrastructureError);
		expect(e.name).toBe("EVENT_HARVEST_FAILED");
	});
});

describe("UnenrolledChangesError", () => {
	it("is a BaseError but NOT an InfrastructureError (crash-loud programming bug)", () => {
		const e = new UnenrolledChangesError("order-1");
		expect(isBaseError(e)).toBe(true);
		expect(e).not.toBeInstanceOf(InfrastructureError);
		expect(e.name).toBe("UNENROLLED_CHANGES");
		expect(e.aggregateId).toBe("order-1");
	});
});
