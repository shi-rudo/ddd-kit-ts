import { err, type Result } from "@shirudo/result";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import {
	DuplicateHandlerRegistrationError,
	ErrorMapperFailedError,
} from "../core/errors";
import { CommandBus } from "./command-bus";
import { QueryBus } from "./query-bus";

/** A consumer error type carried end-to-end through the bus. */
class AppError {
	constructor(
		readonly code: string,
		readonly cause?: unknown,
	) {}
}

class ExpectedFailure extends Error {}

const toAppError = (thrown: unknown): AppError =>
	new AppError(thrown instanceof Error ? thrown.message : "UNKNOWN", thrown);

const mapExpectedAppError = (
	thrown: unknown,
): { readonly error: AppError } | undefined =>
	thrown instanceof ExpectedFailure ? { error: toAppError(thrown) } : undefined;

type Commands = { Create: { id: string } };
type Queries = { GetName: string };

describe("CommandBus typed error channel", () => {
	it("carries a handler's typed err(E) through execute unchanged", async () => {
		const bus = new CommandBus<Commands, AppError>();
		bus.register("Create", async () => err(new AppError("DENIED")));

		const result = await bus.execute({ type: "Create", id: "x" });

		expectTypeOf(result).toEqualTypeOf<Result<{ id: string }, AppError>>();
		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toBeInstanceOf(AppError);
			expect(result.error.code).toBe("DENIED");
		}
	});

	it("maps a recognized thrown value into the typed channel via mapExpectedError", async () => {
		const bus = new CommandBus<Commands, AppError>({
			mapExpectedError: mapExpectedAppError,
		});
		bus.register("Create", async () => {
			throw new ExpectedFailure("boom");
		});

		const result = await bus.execute({ type: "Create", id: "x" });

		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error.code).toBe("boom");
	});

	it("the no-handler dispatch throws past mapExpectedError (wiring bug, not a channel value)", async () => {
		const bus = new CommandBus<Commands, AppError>({
			mapExpectedError: mapExpectedAppError,
		});

		await expect(bus.execute({ type: "Create", id: "x" })).rejects.toThrow(
			"No handler registered for command type: Create",
		);
	});

	it("keeps returned string errors in the default channel", async () => {
		const bus = new CommandBus<Commands>();
		bus.register("Create", async () => err("nope"));

		const result = await bus.execute({ type: "Create", id: "x" });

		expectTypeOf(result).toEqualTypeOf<Result<{ id: string }, string>>();
		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toBe("nope");
	});

	it("allows a widened channel without a mapper because throws propagate", () => {
		const noMapper = () => new CommandBus<Commands, AppError>();
		expect(typeof noMapper).toBe("function");
	});

	it("keeps literal-union channels closed under explicit mapping", () => {
		type Codes = "DB_CONN" | "TIMEOUT";
		const noCommandMapper = () => new CommandBus<Commands, Codes>();
		const noQueryMapper = () => new QueryBus<Queries, Codes>();
		const withMapper = () =>
			new CommandBus<Commands, Codes>({
				mapExpectedError: () => ({ error: "TIMEOUT" }),
			});

		expect(typeof noCommandMapper).toBe("function");
		expect(typeof noQueryMapper).toBe("function");
		expect(typeof withMapper).toBe("function");
	});

	it("allows an unknown channel without flattening thrown values", () => {
		const noUnknownMapper = () => new CommandBus<Commands, unknown>();
		const withUnknownMapper = () =>
			new CommandBus<Commands, unknown>({
				mapExpectedError: (thrown) => ({ error: thrown }),
			});

		expect(typeof noUnknownMapper).toBe("function");
		expect(typeof withUnknownMapper).toBe("function");
	});

	it("rejects the removed catch-all errorMapper option (compile-time)", () => {
		const legacyCommandMapper = () =>
			new CommandBus<Commands, AppError>({
				// @ts-expect-error use mapExpectedError and classify explicitly
				errorMapper: toAppError,
			});
		const legacyQueryMapper = () =>
			new QueryBus<Queries, AppError>({
				// @ts-expect-error use mapExpectedError and classify explicitly
				errorMapper: toAppError,
			});
		expect(typeof legacyCommandMapper).toBe("function");
		expect(typeof legacyQueryMapper).toBe("function");
	});
});

describe("a throwing mapExpectedError must not destroy the handler's failure", () => {
	const handlerFailure = new Error("pool exhausted");
	const mapperFailure = new Error("mapper blew up");
	const throwingMapper = (): { readonly error: AppError } | undefined => {
		throw mapperFailure;
	};

	it("CommandBus: execute rejects with ErrorMapperFailedError carrying both causes", async () => {
		const bus = new CommandBus<Commands, AppError>({
			mapExpectedError: throwingMapper,
		});
		bus.register("Create", async () => {
			throw handlerFailure;
		});

		const rejection = await bus
			.execute({ type: "Create", id: "x" })
			.then(() => undefined)
			.catch((thrown: unknown) => thrown);

		expect(rejection).toBeInstanceOf(ErrorMapperFailedError);
		const failed = rejection as ErrorMapperFailedError;
		expect(failed.cause).toBe(handlerFailure);
		expect(failed.mapperCause).toBe(mapperFailure);
		expect(failed.busKind).toBe("command");
	});

	it("a NESTED dispatch's ErrorMapperFailedError stays a throw (never mapped by the outer bus)", async () => {
		// Same posture as a nested UnregisteredHandlerError: a mis-wired
		// inner bus is a wiring bug and must not surface as an ordinary
		// err value of the outer channel.
		const inner = new CommandBus<Commands, AppError>({
			mapExpectedError: throwingMapper,
		});
		inner.register("Create", async () => {
			throw handlerFailure;
		});
		const outer = new CommandBus<{ Wrap: { id: string } }, AppError>({
			mapExpectedError: mapExpectedAppError,
		});
		outer.register("Wrap", async () =>
			inner.execute({ type: "Create", id: "x" }),
		);

		const rejection = await outer
			.execute({ type: "Wrap", id: "x" })
			.then(() => undefined)
			.catch((thrown: unknown) => thrown);

		expect(rejection).toBeInstanceOf(ErrorMapperFailedError);
		expect((rejection as ErrorMapperFailedError).busKind).toBe("command");
	});

	it("QueryBus: execute rejects with ErrorMapperFailedError carrying both causes", async () => {
		const bus = new QueryBus<Queries, AppError>({
			mapExpectedError: throwingMapper,
		});
		bus.register("GetName", async () => {
			throw handlerFailure;
		});

		const rejection = await bus
			.execute({ type: "GetName" })
			.then(() => undefined)
			.catch((thrown: unknown) => thrown);

		expect(rejection).toBeInstanceOf(ErrorMapperFailedError);
		const failed = rejection as ErrorMapperFailedError;
		expect(failed.cause).toBe(handlerFailure);
		expect(failed.mapperCause).toBe(mapperFailure);
		expect(failed.busKind).toBe("query");
	});
});

describe("QueryBus typed error channel", () => {
	it("maps a recognized thrown value into the typed channel via mapExpectedError", async () => {
		const bus = new QueryBus<Queries, AppError>({
			mapExpectedError: mapExpectedAppError,
		});
		bus.register("GetName", async () => {
			throw new ExpectedFailure("db down");
		});

		const result = await bus.execute({ type: "GetName" });

		expectTypeOf(result).toEqualTypeOf<Result<string, AppError>>();
		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error.code).toBe("db down");
	});

	it("executeUnsafe still throws the raw error, bypassing the mapper", async () => {
		const bus = new QueryBus<Queries, AppError>({
			mapExpectedError: mapExpectedAppError,
		});
		bus.register("GetName", async () => {
			throw new Error("db down");
		});

		await expect(bus.executeUnsafe({ type: "GetName" })).rejects.toThrow(
			"db down",
		);
	});
});

describe("duplicate handler registration is a named wiring error", () => {
	it("CommandBus.register throws DuplicateHandlerRegistrationError with busKind and messageType", () => {
		const bus = new CommandBus<Commands>();
		bus.register("Create", async () => err("first"));

		const thrown = ((): unknown => {
			try {
				bus.register("Create", async () => err("second"));
				return undefined;
			} catch (e) {
				return e;
			}
		})();

		expect(thrown).toBeInstanceOf(DuplicateHandlerRegistrationError);
		const error = thrown as DuplicateHandlerRegistrationError;
		expect(error.code).toBe("DUPLICATE_HANDLER_REGISTRATION");
		expect(error.busKind).toBe("command");
		expect(error.messageType).toBe("Create");
		// Boundaries matching the historical message keep working.
		expect(error.message).toContain("already registered");
	});

	it("QueryBus.register throws the same named error with busKind query", () => {
		const bus = new QueryBus<Queries>();
		bus.register("GetName", async () => "a");

		const thrown = ((): unknown => {
			try {
				bus.register("GetName", async () => "b");
				return undefined;
			} catch (e) {
				return e;
			}
		})();

		expect(thrown).toBeInstanceOf(DuplicateHandlerRegistrationError);
		expect((thrown as DuplicateHandlerRegistrationError).busKind).toBe("query");
	});
});
