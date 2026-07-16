import { describe, expect, it } from "vite-plus/test";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import { MissingHandlerError } from "../core/errors";
import type { TransactionScope } from "../repo/scope";
import { InMemoryProjectionCheckpointStore } from "./in-memory-checkpoint-store";
import {
	ignoreProjectionEvent,
	projectionFromHandlers,
} from "./projection-from-handlers";
import { Projector } from "./projector";

type OrderPlaced = DomainEvent<"OrderPlaced", { total: number }>;
type OrderShipped = DomainEvent<"OrderShipped", { trackingNumber: string }>;
type OrderEvent = OrderPlaced | OrderShipped;

describe("projectionFromHandlers", () => {
	it("dispatches each event to its discriminator-narrowed handler", async () => {
		const writes: string[] = [];
		const projection = projectionFromHandlers<OrderEvent, string>({
			name: "order-list",
			handlers: {
				OrderPlaced: async (ctx, event) => {
					writes.push(`${ctx}:placed:${event.payload.total}`);
				},
				OrderShipped: async (ctx, event) => {
					writes.push(`${ctx}:shipped:${event.payload.trackingNumber}`);
				},
			},
		});

		await projection.apply(
			"tx-1",
			createDomainEvent("OrderPlaced", { total: 42 }),
		);

		expect(writes).toEqual(["tx-1:placed:42"]);
	});

	it("requires an explicit sentinel for a deliberately ignored event", async () => {
		expect(ignoreProjectionEvent).toBeTypeOf("symbol");
		const writes: string[] = [];
		const projection = projectionFromHandlers<OrderEvent, undefined>({
			name: "placed-orders",
			handlers: {
				OrderPlaced: async (_ctx, event) => {
					writes.push(event.eventId);
				},
				OrderShipped: ignoreProjectionEvent,
			},
		});

		await projection.apply(
			undefined,
			createDomainEvent("OrderShipped", { trackingNumber: "TRACK-1" }),
		);

		expect(writes).toEqual([]);
	});

	it("requires one handler or ignore sentinel for every declared event type", () => {
		const invalidProjection = () =>
			projectionFromHandlers<OrderEvent, undefined>({
				name: "incomplete-order-list",
				// @ts-expect-error OrderShipped needs a handler or ignore sentinel
				handlers: {
					OrderPlaced: async () => {},
				},
			});

		const completeProjection = projectionFromHandlers<OrderEvent, undefined>({
			name: "complete-order-list",
			handlers: {
				OrderPlaced: async () => {},
				OrderShipped: ignoreProjectionEvent,
			},
		});

		expect(invalidProjection).toBeTypeOf("function");
		expect(completeProjection.apply).toBeTypeOf("function");
	});

	it("passes the optional truncate callback through to the projection", async () => {
		const truncatedWith: string[] = [];
		const projection = projectionFromHandlers<OrderEvent, string>({
			name: "order-list",
			handlers: {
				OrderPlaced: async () => {},
				OrderShipped: ignoreProjectionEvent,
			},
			truncate: async (ctx: string) => {
				truncatedWith.push(ctx);
			},
		});

		await projection.truncate?.("tx-reset");

		expect(truncatedWith).toEqual(["tx-reset"]);
	});

	it.each([
		"UnknownOrderEvent",
		"toString",
		"constructor",
		"__proto__",
		"hasOwnProperty",
	])(
		"rejects undeclared event type %s through the own-key guard",
		async (type) => {
			const projection = projectionFromHandlers<OrderEvent, undefined>({
				name: "order-list",
				handlers: {
					OrderPlaced: async () => {},
					OrderShipped: ignoreProjectionEvent,
				},
			});
			const event = {
				...createDomainEvent("OrderPlaced", { total: 1 }),
				type,
			} as OrderEvent;

			const rejection = await projection.apply(undefined, event).then(
				() => undefined,
				(error: unknown) => error,
			);

			expect(rejection).toBeInstanceOf(MissingHandlerError);
			expect(rejection).toMatchObject({
				code: "MISSING_HANDLER",
				eventType: type,
			});
		},
	);

	it("rejects an undeclared runtime type without advancing its checkpoint", async () => {
		const writes: string[] = [];
		const projection = projectionFromHandlers<OrderEvent, undefined>({
			name: "order-list",
			handlers: {
				OrderPlaced: async (_ctx, event) => {
					writes.push(event.eventId);
				},
				OrderShipped: ignoreProjectionEvent,
			},
		});
		const checkpoints = new InMemoryProjectionCheckpointStore();
		const scope: TransactionScope<undefined> = {
			transactional: (work) => work(undefined),
		};
		const projector = new Projector({ scope, checkpoints, projection });
		const source = { aggregateType: "Order", aggregateId: "order-1" };
		const event = {
			...createDomainEvent("OrderPlaced", { total: 1 }, source),
			type: "constructor",
		} as unknown as OrderEvent;

		await expect(
			projector.project([
				{
					event,
					source,
					position: {
						aggregateVersion: 1,
						commitSequence: 0,
						commitSize: 1,
						previousEventfulAggregateVersion: null,
					},
				},
			]),
		).rejects.toBeInstanceOf(MissingHandlerError);
		expect(writes).toEqual([]);
		await expect(
			checkpoints.load(undefined, projection.name, source),
		).resolves.toBeUndefined();
	});
});
