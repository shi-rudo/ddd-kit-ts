import {
	findInCauseChain,
	getRootCause,
	isBaseError,
	isRetryable,
} from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import {
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DomainError,
	DuplicateAggregateError,
	EventHarvestError,
	InfrastructureError,
	MissingHandlerError,
	UnenrolledChangesError,
} from "./errors";

describe("DomainError", () => {
	it("is abstract; only consumer subclasses are constructible", () => {
		class OrderAlreadyShippedError extends DomainError<"OrderAlreadyShippedError"> {
			constructor(orderId: string) {
				super(`Order ${orderId} is already shipped`);
			}
		}

		const e = new OrderAlreadyShippedError("o-1");
		expect(e).toBeInstanceOf(DomainError);
		expect(e.name).toBe("OrderAlreadyShippedError");
		expect(e.message).toBe("Order o-1 is already shipped");
	});

	it("is not an InfrastructureError, so App-layer catches stay separable", () => {
		class OrderError extends DomainError {
			constructor() {
				super("nope");
			}
		}
		expect(new OrderError()).not.toBeInstanceOf(InfrastructureError);
	});

	it("inherits BaseError surface: timestamp, isBaseError detection", () => {
		class OrderError extends DomainError {
			constructor() {
				super("nope");
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
		class OrderError extends DomainError {
			constructor(cause: unknown) {
				super("wrapped", cause);
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
		class DriverTimeout extends InfrastructureError<"DriverTimeout"> {
			constructor() {
				super("timeout");
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
		// swallow a forgotten event handler: that's a programming bug
		// that should crash loud during development.
		const e = new MissingHandlerError("OrderShipped");
		expect(e).not.toBeInstanceOf(DomainError);
		expect(e).not.toBeInstanceOf(InfrastructureError);
		expect(isBaseError(e)).toBe(true);
		expect(e.name).toBe("MissingHandlerError");
		expect(e.eventType).toBe("OrderShipped");
		expect(e.message).toContain("OrderShipped");
	});

	it("accepts a cause and preserves it in the chain", () => {
		const root = new Error("registry lookup failed");
		const e = new MissingHandlerError("OrderShipped", root);
		expect(getRootCause(e)).toBe(root);
	});
});

describe("AggregateNotFoundError", () => {
	it("carries aggregate type and id in the technical message", () => {
		const e = new AggregateNotFoundError("Order", "o-1");
		expect(e.aggregateType).toBe("Order");
		expect(e.id).toBe("o-1");
		expect(e.message).toContain("Order(o-1)"); // technical
	});

	it("is NOT retryable: the row isn't there; retry won't help", () => {
		expect(isRetryable(new AggregateNotFoundError("Order", "o-1"))).toBe(false);
	});

	it("preserves a wrapped driver error via cause", () => {
		const driverErr = new Error("postgres: no rows in result set");
		const e = new AggregateNotFoundError("Order", "o-1", driverErr);
		expect(getRootCause(e)).toBe(driverErr);
	});
});

describe("DuplicateAggregateError", () => {
	it("carries aggregate type and id in the technical message", () => {
		const e = new DuplicateAggregateError("Order", "o-1");
		expect(e.aggregateType).toBe("Order");
		expect(e.aggregateId).toBe("o-1");
		expect(e.name).toBe("DuplicateAggregateError");
		expect(e.message).toContain("Order(o-1)"); // technical
	});

	it("is an InfrastructureError and NOT retryable: re-running the same INSERT cannot succeed", () => {
		const e = new DuplicateAggregateError("Order", "o-1");
		expect(e).toBeInstanceOf(InfrastructureError);
		expect(isRetryable(e)).toBe(false);
	});

	it("preserves the wrapped driver error via cause", () => {
		const driverErr = Object.assign(new Error("duplicate key value"), {
			code: "23505",
		});
		const e = new DuplicateAggregateError("Order", "o-1", driverErr);
		expect(getRootCause(e)).toBe(driverErr);
	});
});

describe("ConcurrencyConflictError", () => {
	it("carries expected/actual versions for OCC reporting", () => {
		const e = new ConcurrencyConflictError("Order", "o-1", 3, 5);
		expect(e.aggregateType).toBe("Order");
		expect(e.aggregateId).toBe("o-1");
		expect(e.expectedVersion).toBe(3);
		expect(e.actualVersion).toBe(5);
		expect(e.message).toContain("expected version 3");
		expect(e.message).toContain("actual 5");
	});

	it("marks itself retryable so isRetryable picks it up: the OCC reload-and-retry pattern", () => {
		const e = new ConcurrencyConflictError("Order", "o-1", 3, 5);
		expect(e.retryable).toBe(true);
		expect(isRetryable(e)).toBe(true);
	});

	it("retryable hint survives wrapping in a use-case-level DomainError", () => {
		class FailedToConfirmOrderError extends DomainError {
			constructor(cause: unknown) {
				super("Failed to confirm order", cause);
			}
		}
		const root = new ConcurrencyConflictError("Order", "o-1", 3, 5);
		const wrapped = new FailedToConfirmOrderError(root);

		// The cause-chain helpers find the retryable root; an App-Service
		// orchestrator inspecting the root can decide to retry.
		expect(getRootCause(wrapped)).toBe(root);
		expect(isRetryable(getRootCause(wrapped))).toBe(true);
	});

	it("serialises to JSON with name, message, and timestamp for structured logging", () => {
		const e = new ConcurrencyConflictError("Order", "o-1", 3, 5);
		const json = e.toJSON();
		expect(json.name).toBe("ConcurrencyConflictError");
		expect(json.message).toContain("Order(o-1)");
		expect(json.timestamp).toBeDefined();
	});
});

describe("EventHarvestError", () => {
	it("is a BaseError but NOT an InfrastructureError (deterministic, not retryable)", () => {
		const e = new EventHarvestError("bad event");
		expect(isBaseError(e)).toBe(true);
		expect(e).not.toBeInstanceOf(InfrastructureError);
		expect(e.name).toBe("EventHarvestError");
	});
});

describe("UnenrolledChangesError", () => {
	it("is a BaseError but NOT an InfrastructureError (crash-loud programming bug)", () => {
		const e = new UnenrolledChangesError("order-1");
		expect(isBaseError(e)).toBe(true);
		expect(e).not.toBeInstanceOf(InfrastructureError);
		expect(e.name).toBe("UnenrolledChangesError");
		expect(e.aggregateId).toBe("order-1");
	});
});
