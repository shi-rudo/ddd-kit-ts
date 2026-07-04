import { err, type Result } from "@shirudo/result";
import { describe, expect, expectTypeOf, it } from "vitest";
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
