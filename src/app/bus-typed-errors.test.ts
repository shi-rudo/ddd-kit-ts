import { err, type Result } from "@shirudo/result";
import { describe, expect, expectTypeOf, it } from "vitest";
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

const toAppError = (thrown: unknown): AppError =>
	new AppError(thrown instanceof Error ? thrown.message : "UNKNOWN", thrown);

type Commands = { Create: { id: string } };
type Queries = { GetName: string };

describe("CommandBus typed error channel", () => {
	it("carries a handler's typed err(E) through execute unchanged", async () => {
		const bus = new CommandBus<Commands, AppError>({ errorMapper: toAppError });
		bus.register("Create", async () => err(new AppError("DENIED")));

		const result = await bus.execute({ type: "Create", id: "x" });

		expectTypeOf(result).toEqualTypeOf<Result<{ id: string }, AppError>>();
		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toBeInstanceOf(AppError);
			expect(result.error.code).toBe("DENIED");
		}
	});

	it("maps a thrown value into the typed channel via errorMapper", async () => {
		const bus = new CommandBus<Commands, AppError>({ errorMapper: toAppError });
		bus.register("Create", async () => {
			throw new Error("boom");
		});

		const result = await bus.execute({ type: "Create", id: "x" });

		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error.code).toBe("boom");
	});

	it("the no-handler dispatch throws past the errorMapper (wiring bug, not a channel value)", async () => {
		const bus = new CommandBus<Commands, AppError>({ errorMapper: toAppError });

		await expect(bus.execute({ type: "Create", id: "x" })).rejects.toThrow(
			"No handler registered for command type: Create",
		);
	});

	it("defaults to a string channel with no options (backward compatible)", async () => {
		const bus = new CommandBus<Commands>();
		bus.register("Create", async () => err("nope"));

		const result = await bus.execute({ type: "Create", id: "x" });

		expectTypeOf(result).toEqualTypeOf<Result<{ id: string }, string>>();
		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error).toBe("nope");
	});

	it("requires an errorMapper once the channel is widened (compile-time)", () => {
		// The function body is type-checked but never invoked; the assertion is
		// that the missing required `errorMapper` is a compile error.
		const missingMapper = () =>
			// @ts-expect-error widened E without an errorMapper is rejected
			new CommandBus<Commands, AppError>();
		expect(typeof missingMapper).toBe("function");
	});

	it("requires an errorMapper for a string-literal-union channel (compile-time)", () => {
		// Every subtype of string passes [E] extends [string]; the gate must
		// use [string] extends [E] so an error-code union cannot silently
		// fall back to describeThrown, whose arbitrary strings would escape
		// the declared union and fall through exhaustive switches.
		type Codes = "DB_CONN" | "TIMEOUT";
		const missingCommandMapper = () =>
			// @ts-expect-error a literal-union E without an errorMapper is rejected
			new CommandBus<Commands, Codes>();
		const missingQueryMapper = () =>
			// @ts-expect-error a literal-union E without an errorMapper is rejected
			new QueryBus<Queries, Codes>();
		const withMapper = () =>
			new CommandBus<Commands, Codes>({ errorMapper: () => "TIMEOUT" });

		expect(typeof missingCommandMapper).toBe("function");
		expect(typeof missingQueryMapper).toBe("function");
		expect(typeof withMapper).toBe("function");
	});

	it("requires an errorMapper for an unknown channel (compile-time)", () => {
		// describeThrown's string output is assignable to unknown, but an
		// unknown channel says "I handle raw values": silently flattening a
		// rich Error to a string would lose stack, cause, and custom fields.
		// Optional options are reserved for E = string exactly (and the
		// unavoidable any).
		const missingUnknownMapper = () =>
			// @ts-expect-error an unknown E without an errorMapper is rejected
			new CommandBus<Commands, unknown>();
		const withUnknownMapper = () =>
			new CommandBus<Commands, unknown>({ errorMapper: (thrown) => thrown });

		expect(typeof missingUnknownMapper).toBe("function");
		expect(typeof withUnknownMapper).toBe("function");
	});
});

describe("a throwing errorMapper must not destroy the handler's failure", () => {
	const handlerFailure = new Error("pool exhausted");
	const mapperFailure = new Error("mapper blew up");
	const throwingMapper = (): AppError => {
		throw mapperFailure;
	};

	it("CommandBus: execute rejects with ErrorMapperFailedError carrying both causes", async () => {
		const bus = new CommandBus<Commands, AppError>({
			errorMapper: throwingMapper,
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
			errorMapper: throwingMapper,
		});
		inner.register("Create", async () => {
			throw handlerFailure;
		});
		const outer = new CommandBus<{ Wrap: { id: string } }, AppError>({
			errorMapper: toAppError,
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
			errorMapper: throwingMapper,
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
	it("maps a thrown value into the typed channel via errorMapper", async () => {
		const bus = new QueryBus<Queries, AppError>({ errorMapper: toAppError });
		bus.register("GetName", async () => {
			throw new Error("db down");
		});

		const result = await bus.execute({ type: "GetName" });

		expectTypeOf(result).toEqualTypeOf<Result<string, AppError>>();
		expect(result.isErr()).toBe(true);
		if (result.isErr()) expect(result.error.code).toBe("db down");
	});

	it("executeUnsafe still throws the raw error, bypassing the mapper", async () => {
		const bus = new QueryBus<Queries, AppError>({ errorMapper: toAppError });
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
		expect((thrown as DuplicateHandlerRegistrationError).busKind).toBe(
			"query",
		);
	});
});
