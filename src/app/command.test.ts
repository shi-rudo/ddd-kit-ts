import { describe, expect, it } from "vitest";
import { err, ok } from "../core/result";
import type { Command, CommandHandler } from "./command";

describe("Command", () => {
	describe("Command interface", () => {
		it("should allow creating command types", () => {
			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
				items: string[];
			};

			const command: CreateOrderCommand = {
				type: "CreateOrder",
				customerId: "customer-123",
				items: ["item-1", "item-2"],
			};

			expect(command.type).toBe("CreateOrder");
			expect(command.customerId).toBe("customer-123");
			expect(command.items).toHaveLength(2);
		});

		it("should enforce readonly type property", () => {
			type TestCommand = Command & {
				type: "TestCommand";
				value: string;
			};

			const command: TestCommand = {
				type: "TestCommand",
				value: "test",
			};

			// TypeScript should prevent: command.type = "Other";
			expect(command.type).toBe("TestCommand");
		});
	});

	describe("CommandHandler", () => {
		it("should allow creating command handlers", async () => {
			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			const handler: CommandHandler<CreateOrderCommand, string> = async (
				cmd,
			) => {
				expect(cmd.type).toBe("CreateOrder");
				expect(cmd.customerId).toBe("customer-123");
				return ok("order-456");
			};

			const result = await handler({
				type: "CreateOrder",
				customerId: "customer-123",
			});

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).toBe("order-456");
			}
		});

		it("should handle errors in command handlers", async () => {
			type CreateOrderCommand = Command & {
				type: "CreateOrder";
				customerId: string;
			};

			const handler: CommandHandler<CreateOrderCommand, string> = async (
				cmd,
			) => {
				if (cmd.customerId === "invalid") {
					return err("Invalid customer");
				}
				return ok("order-123");
			};

			const successResult = await handler({
				type: "CreateOrder",
				customerId: "valid",
			});
			expect(successResult.ok).toBe(true);

			const errorResult = await handler({
				type: "CreateOrder",
				customerId: "invalid",
			});
			expect(errorResult.ok).toBe(false);
			if (!errorResult.ok) {
				expect(errorResult.error).toBe("Invalid customer");
			}
		});
	});
});

