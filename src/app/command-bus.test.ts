import { err, ok, type Result } from "@shirudo/result";
import { describe, expect, expectTypeOf, it } from "vitest";
import { UnregisteredHandlerError } from "../core/errors";
import type { Command } from "./command";
import { CommandBus } from "./command-bus";

describe("CommandBus", () => {
	describe("register", () => {
		it("should register command handlers", () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			const handler = async (cmd: CreateOrderCommand) => {
				return ok("order-123");
			};

			bus.register("CreateOrder", handler);
			// Should not throw
		});

		it("should allow registering multiple handlers for different command types", () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			type CancelOrderCommand = Command & {
				type: "CancelOrder";
				orderId: string;
			};

			bus.register("CreateOrder", async () => ok("order-1"));
			bus.register("CancelOrder", async () => ok("cancelled"));
			// Should not throw
		});

		it("throws on duplicate registration instead of silently replacing the handler", () => {
			const bus = new CommandBus();

			bus.register("CreateOrder", async () => ok("a"));

			// Silent overwrite turns the first handler into dead code with
			// no signal; wiring bugs must surface at startup.
			expect(() => bus.register("CreateOrder", async () => ok("b"))).toThrow(
				/already registered/,
			);
		});
	});

	describe("execute", () => {
		it("should execute registered command handler", async () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			bus.register("CreateOrder", async (cmd: CreateOrderCommand) => {
				expect(cmd.customerId).toBe("customer-123");
				return ok("order-456");
			});

			const result = await bus.execute({
				type: "CreateOrder",
				customerId: "customer-123",
			});

			expect(result.isOk()).toBe(true);
			if (result.isOk()) {
				expect(result.value).toBe("order-456");
			}
		});

		it("should return error if no handler is registered", async () => {
			const bus = new CommandBus();

			type UnknownCommand = Command & {
				type: "UnknownCommand";
			};

			const result = await bus.execute({
				type: "UnknownCommand",
			});

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toContain("No handler registered");
			}
		});

		it("surfaces an unregistered command type as a named UnregisteredHandlerError through the errorMapper", async () => {
			// The kit's posture treats mis-wiring as a bug that must not be
			// absorbed by generic domain-error handling; the NAMED type lets
			// a typed error channel route it explicitly (and pins the wire
			// message the default string channel has always produced).
			const bus = new CommandBus<Record<string, unknown>, unknown>({
				errorMapper: (thrown) => thrown,
			});

			const result = await bus.execute({ type: "UnknownCommand" });

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toBeInstanceOf(UnregisteredHandlerError);
				const error = result.error as UnregisteredHandlerError;
				expect(error.busKind).toBe("command");
				expect(error.messageType).toBe("UnknownCommand");
				expect(error.message).toBe(
					"No handler registered for command type: UnknownCommand",
				);
			}
		});

		it("should handle errors from command handlers", async () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			bus.register("CreateOrder", async () => {
				return err("Failed to create order");
			});

			const result = await bus.execute({
				type: "CreateOrder",
				customerId: "customer-123",
			});

			expect(result.isErr()).toBe(true);
			if (result.isErr()) {
				expect(result.error).toBe("Failed to create order");
			}
		});

		it("should handle multiple command types", async () => {
			const bus = new CommandBus();

			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			type UpdateOrderCommand = Command & {
				type: "UpdateOrder";
				orderId: string;
				status: string;
			};

			bus.register("CreateOrder", async () => ok("order-1"));
			bus.register("UpdateOrder", async (cmd: UpdateOrderCommand) => {
				return ok(`updated-${cmd.orderId}`);
			});

			const createResult = await bus.execute({
				type: "CreateOrder",
				customerId: "customer-123",
			});
			expect(createResult.isOk()).toBe(true);

			const updateResult = await bus.execute({
				type: "UpdateOrder",
				orderId: "order-1",
				status: "shipped",
			});
			expect(updateResult.isOk()).toBe(true);
			if (updateResult.isOk()) {
				expect(updateResult.value).toBe("updated-order-1");
			}
		});
	});

	describe("type inference with TMap", () => {
		it("should infer return type from type map", async () => {
			type Commands = {
				CreateOrder: string;
				CancelOrder: void;
			};

			const bus = new CommandBus<Commands>();

			bus.register("CreateOrder", async () => ok("order-123"));
			bus.register("CancelOrder", async () => ok(undefined as void));

			const createResult = await bus.execute({
				type: "CreateOrder" as const,
				customerId: "c-1",
			});

			expectTypeOf(createResult).toEqualTypeOf<Result<string, string>>();

			const cancelResult = await bus.execute({
				type: "CancelOrder" as const,
			});

			expectTypeOf(cancelResult).toEqualTypeOf<Result<void, string>>();
		});

		it("should return Result<unknown, string> without type map", async () => {
			const bus = new CommandBus();

			bus.register("CreateOrder", async () => ok("order-123"));

			const result = await bus.execute({ type: "CreateOrder" });

			expectTypeOf(result).toEqualTypeOf<Result<unknown, string>>();
		});
	});

	describe("register() typing constrained by TMap", () => {
		it("rejects registering an unknown command type", () => {
			type Commands = {
				CreateOrder: string;
				CancelOrder: void;
			};
			const bus = new CommandBus<Commands>();

			// @ts-expect-error: "Unknown" is not a key of TMap
			bus.register("Unknown", async () => ok("x"));
		});

		it("rejects a handler whose return type does not match TMap[K]", () => {
			type Commands = {
				CreateOrder: string;
			};
			const bus = new CommandBus<Commands>();

			// @ts-expect-error: TMap says CreateOrder returns string; ok(42) is Result<number,…>
			bus.register("CreateOrder", async () => ok(42));
		});

		it("accepts a correctly-typed handler", () => {
			type Commands = {
				CreateOrder: string;
			};
			const bus = new CommandBus<Commands>();

			// no @ts-expect-error: must compile cleanly
			bus.register("CreateOrder", async () => ok("order-123"));
		});

		it("stays loose when no TMap is provided (backwards compatible)", () => {
			const bus = new CommandBus();

			bus.register("CreateOrder", async () => ok("order-1"));
			bus.register("AnyOtherType", async () => ok(42));
		});
	});
});

describe("CommandBus – non-Error throws keep their diagnostics", () => {
	it("serialises a structured thrown object into the error string", async () => {
		const bus = new CommandBus();
		bus.register("CreateOrder", async () => {
			throw { code: "DB_CONN", detail: "pool exhausted" };
		});

		const result = await bus.execute({ type: "CreateOrder" });

		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			// '[object Object]' would destroy all diagnostic information.
			expect(result.error).toContain("DB_CONN");
			expect(result.error).toContain("pool exhausted");
		}
	});
});
