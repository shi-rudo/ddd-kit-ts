import type { Result } from "@shirudo/result";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import { DomainError, InfrastructureError } from "../core/errors";
import {
	type DomainErrorClass,
	domainErrorToResult,
} from "./domain-error-result";

class OrderAlreadyConfirmedError extends DomainError<"ORDER_ALREADY_CONFIRMED"> {
	constructor() {
		super({
			code: "ORDER_ALREADY_CONFIRMED",
			message: "Order is already confirmed",
		});
	}
}

class OrderClosedError extends DomainError<"ORDER_CLOSED"> {
	constructor() {
		super({ code: "ORDER_CLOSED", message: "Order is closed" });
	}
}

class StorageUnavailableError extends InfrastructureError<"STORAGE_UNAVAILABLE"> {
	constructor() {
		super({ code: "STORAGE_UNAVAILABLE", message: "Storage is unavailable" });
	}
}

describe("domainErrorToResult", () => {
	it("wraps a successful sync or async operation in Ok with the inferred error union", async () => {
		const syncResult = await domainErrorToResult(
			() => "confirmed" as const,
			[OrderAlreadyConfirmedError],
		);
		const asyncResult = await domainErrorToResult(
			async () => 42 as const,
			[OrderAlreadyConfirmedError, OrderClosedError],
		);

		expect(syncResult.isOk()).toBe(true);
		expect(asyncResult.isOk()).toBe(true);
		if (syncResult.isOk()) expect(syncResult.value).toBe("confirmed");
		if (asyncResult.isOk()) expect(asyncResult.value).toBe(42);
		expectTypeOf(syncResult).toEqualTypeOf<
			Result<"confirmed", OrderAlreadyConfirmedError>
		>();
		expectTypeOf(asyncResult).toEqualTypeOf<
			Result<42, OrderAlreadyConfirmedError | OrderClosedError>
		>();
	});

	it("returns the exact listed DomainError instance in Err", async () => {
		const failure = new OrderAlreadyConfirmedError();

		const result = await domainErrorToResult(
			() => {
				throw failure;
			},
			[OrderAlreadyConfirmedError] as const,
		);

		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toBe(failure);
	});

	it("handles a listed DomainError from an async rejection", async () => {
		const failure = new OrderClosedError();

		const result = await domainErrorToResult(
			async () => {
				throw failure;
			},
			[OrderAlreadyConfirmedError, OrderClosedError] as const,
		);

		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toBe(failure);
	});

	it("captures the expected-error policy before asynchronous work starts", async () => {
		const failure = new OrderAlreadyConfirmedError();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const expectedErrors: [DomainErrorClass] = [OrderAlreadyConfirmedError];
		const pending = domainErrorToResult(async () => {
			await gate;
			throw failure;
		}, expectedErrors);

		expectedErrors[0] = OrderClosedError;
		release();

		const result = await pending;
		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toBe(failure);
	});

	it("rethrows an unlisted DomainError unchanged", async () => {
		const failure = new OrderClosedError();

		await expect(
			domainErrorToResult(
				() => {
					throw failure;
				},
				[OrderAlreadyConfirmedError] as const,
			),
		).rejects.toBe(failure);
	});

	it.each([
		new StorageUnavailableError(),
		new Error("programming defect"),
		AbortSignal.abort("cancelled").reason,
	])("rethrows a non-domain failure unchanged", async (failure) => {
		await expect(
			domainErrorToResult(
				() => {
					throw failure;
				},
				[OrderAlreadyConfirmedError] as const,
			),
		).rejects.toBe(failure);
	});

	it("rejects an empty expected-error list before invoking the operation", async () => {
		let invoked = false;

		await expect(
			domainErrorToResult(
				() => {
					invoked = true;
					return "unreachable";
				},
				// @ts-expect-error an explicit boundary must name at least one error
				[],
			),
		).rejects.toThrow(TypeError);
		expect(invoked).toBe(false);
	});

	it("rejects a non-DomainError class before invoking the operation", async () => {
		let invoked = false;

		await expect(
			domainErrorToResult(
				() => {
					invoked = true;
					return "unreachable";
				},
				// @ts-expect-error only DomainError subclasses define this boundary
				[Error],
			),
		).rejects.toThrow(TypeError);
		expect(invoked).toBe(false);
	});

	it("rejects the abstract DomainError base before invoking the operation", async () => {
		let invoked = false;

		await expect(
			domainErrorToResult(
				() => {
					invoked = true;
					return "unreachable";
				},
				// @ts-expect-error a catch-all DomainError boundary is forbidden
				[DomainError],
			),
		).rejects.toThrow(TypeError);
		expect(invoked).toBe(false);
	});

	it("accepts consumer error constructors without constraining their arguments", () => {
		class OrderLimitExceededError extends DomainError<"ORDER_LIMIT_EXCEEDED"> {
			constructor(readonly limit: number) {
				super({
					code: "ORDER_LIMIT_EXCEEDED",
					message: `Order limit ${limit} exceeded`,
				});
			}
		}

		const errorClass: DomainErrorClass<OrderLimitExceededError> =
			OrderLimitExceededError;

		expect(errorClass).toBe(OrderLimitExceededError);
	});
});
