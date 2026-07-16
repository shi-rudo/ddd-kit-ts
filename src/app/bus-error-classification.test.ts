import { describe, expect, it } from "vite-plus/test";
import { ErrorMapperFailedError, InfrastructureError } from "../core/errors";
import { CommandBus } from "./command-bus";
import { QueryBus } from "./query-bus";

class DatabaseUnavailableError extends InfrastructureError<"DATABASE_UNAVAILABLE"> {
	constructor() {
		super({
			code: "DATABASE_UNAVAILABLE",
			message: "The database is unavailable",
			retryable: true,
		});
	}
}

class ExpectedHandlerFailure extends Error {}

interface AppFailure {
	readonly code: "EXPECTED_FAILURE";
	readonly message: string;
}

const mapExpectedError = (
	thrown: unknown,
): { readonly error: AppFailure } | undefined =>
	thrown instanceof ExpectedHandlerFailure
		? {
				error: {
					code: "EXPECTED_FAILURE",
					message: thrown.message,
				},
			}
		: undefined;

describe("bus handler failure classification", () => {
	it("CommandBus propagates an unknown programmer error unchanged", async () => {
		const failure = new TypeError("broken handler invariant");
		const bus = new CommandBus();
		bus.register("Break", async () => {
			throw failure;
		});

		await expect(bus.execute({ type: "Break" })).rejects.toBe(failure);
	});

	it("QueryBus propagates an infrastructure error unchanged", async () => {
		const failure = new DatabaseUnavailableError();
		const bus = new QueryBus();
		bus.register("Read", async () => {
			throw failure;
		});

		await expect(bus.execute({ type: "Read" })).rejects.toBe(failure);
	});

	it("CommandBus propagates an AbortSignal cancellation reason unchanged", async () => {
		const controller = new AbortController();
		const cancellation = new DOMException("request cancelled", "AbortError");
		controller.abort(cancellation);
		const bus = new CommandBus();
		bus.register("Cancel", async () => {
			throw controller.signal.reason;
		});

		await expect(bus.execute({ type: "Cancel" })).rejects.toBe(cancellation);
	});

	it("maps only a failure explicitly recognized by mapExpectedError", async () => {
		const bus = new CommandBus<Record<string, unknown>, AppFailure>({
			mapExpectedError,
		});
		bus.register("Expected", async () => {
			throw new ExpectedHandlerFailure("credit limit reached");
		});

		const result = await bus.execute({ type: "Expected" });

		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toEqual({
				code: "EXPECTED_FAILURE",
				message: "credit limit reached",
			});
		}
	});

	it("propagates the original failure when mapExpectedError declines it", async () => {
		const failure = new TypeError("unexpected null query result");
		const bus = new QueryBus<Record<string, unknown>, AppFailure>({
			mapExpectedError,
		});
		bus.register("Read", async () => {
			throw failure;
		});

		await expect(bus.execute({ type: "Read" })).rejects.toBe(failure);
	});

	it("can explicitly map an expected failure to undefined", async () => {
		const bus = new QueryBus<Record<string, unknown>, undefined>({
			mapExpectedError: (thrown) =>
				thrown instanceof ExpectedHandlerFailure
					? { error: undefined }
					: undefined,
		});
		bus.register("Read", async () => {
			throw new ExpectedHandlerFailure("not found");
		});

		const result = await bus.execute({ type: "Read" });

		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toBeUndefined();
	});

	it("fails loudly when mapExpectedError returns no decision wrapper", async () => {
		const failure = new ExpectedHandlerFailure("expected");
		const bus = new CommandBus<Record<string, unknown>, AppFailure>({
			mapExpectedError: (() => ({})) as never,
		});
		bus.register("Expected", async () => {
			throw failure;
		});

		const rejection = await bus.execute({ type: "Expected" }).then(
			() => undefined,
			(thrown: unknown) => thrown,
		);

		expect(rejection).toBeInstanceOf(ErrorMapperFailedError);
		const mapperFailure = rejection as ErrorMapperFailedError;
		expect(mapperFailure.cause).toBe(failure);
		expect(mapperFailure.mapperCause).toBeInstanceOf(TypeError);
	});
});
