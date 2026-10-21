import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type { StandardSchemaV1 } from "../../internal/standard-schema";
import type { Version } from "../aggregate/aggregate";
import { EventSourcedAggregate } from "../aggregate/event-sourced-aggregate";
import { StateStoredAggregate } from "../aggregate/state-stored-aggregate";
import type { Id } from "../identity/id";
import {
	createDomainEvent,
	createDomainEventFactory,
	createStampedDomainEvent,
	type DomainEvent,
} from "./domain-event";
import {
	type DomainEventOf,
	defineDomainEvent,
} from "./domain-event-definition";
import { DomainEventValidationError } from "./domain-event-errors";

/** A schema that meets the Standard Schema spec without a schema library. */
function standardSchema<Input, Output>(
	validate: (
		value: unknown,
	) =>
		| StandardSchemaV1.Result<Output>
		| Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<Input, Output> {
	return { "~standard": { version: 1, vendor: "test", validate } };
}

type OrderLineInput = { sku: string; quantity: number; note?: string };
type OrderPlacedInput = { orderId: string; lines: OrderLineInput[] };
type OrderPlacedPayload = {
	readonly orderId: string;
	readonly lines: ReadonlyArray<{
		readonly sku: string;
		readonly quantity: number;
	}>;
};

/** Checks the fields and builds fresh objects without unknown keys. */
const orderPlacedSchema = standardSchema<OrderPlacedInput, OrderPlacedPayload>(
	(value) => {
		const input = value as Partial<OrderPlacedInput> | undefined;
		const issues: StandardSchemaV1.Issue[] = [];
		if (typeof input?.orderId !== "string") {
			issues.push({ message: "orderId must be a string", path: ["orderId"] });
		}
		const lines = Array.isArray(input?.lines) ? input.lines : [];
		lines.forEach((line, index) => {
			if (typeof line?.quantity !== "number") {
				issues.push({
					message: "quantity must be a number",
					path: ["lines", { key: index }, "quantity"],
				});
			}
		});
		if (issues.length > 0) return { issues };
		return {
			value: {
				orderId: input?.orderId as string,
				lines: lines.map((line) => ({
					sku: line.sku,
					quantity: line.quantity,
				})),
			},
		};
	},
);

const OrderPlaced = defineDomainEvent("OrderPlaced", {
	payload: orderPlacedSchema,
	schemaVersion: 2,
});

/** Passes every value through, as `z.any()` does. */
const anything = defineDomainEvent("AnythingHappened", {
	payload: standardSchema<unknown, unknown>((value) => ({ value })),
});

const placeOrder = (): OrderPlacedInput => ({
	orderId: "o-1",
	lines: [
		{ sku: "a", quantity: 1, note: "dropped by the schema" },
		{ sku: "b", quantity: 2 },
	],
});

function rejectionOf(create: () => unknown): unknown {
	try {
		create();
	} catch (error) {
		return error;
	}
	return "no error";
}

describe("defineDomainEvent", () => {
	it("returns a frozen definition with the type, the schema version, and the schema", () => {
		expect(OrderPlaced.type).toBe("OrderPlaced");
		expect(OrderPlaced.schemaVersion).toBe(2);
		expect(OrderPlaced.payload).toBe(orderPlacedSchema);
		expect(Object.isFrozen(OrderPlaced)).toBe(true);
	});

	it("defaults the schema version to 1", () => {
		expect(anything.schemaVersion).toBe(1);
	});

	it("rejects a payload option that is not a Standard Schema", () => {
		const rejection = rejectionOf(() =>
			defineDomainEvent("Broken", {
				payload: {} as StandardSchemaV1,
			}),
		);

		expect(rejection).toBeInstanceOf(TypeError);
	});

	it("rejects a blank type and an invalid schema version with their codes", () => {
		const blank = rejectionOf(() =>
			defineDomainEvent(" ", { payload: orderPlacedSchema }),
		);
		const version = rejectionOf(() =>
			defineDomainEvent("OrderPlaced", {
				payload: orderPlacedSchema,
				schemaVersion: 0,
			}),
		);

		expect(blank).toMatchObject({ code: "EVENT_TYPE_INVALID" });
		expect(version).toMatchObject({ code: "EVENT_SCHEMA_VERSION_INVALID" });
	});
});

describe("an event created from a definition", () => {
	it("carries the schema output as its payload and the version of the definition", () => {
		const event = createDomainEvent(OrderPlaced, placeOrder());

		expect(event.type).toBe("OrderPlaced");
		expect(event.schemaVersion).toBe(2);
		expect(event.payload).toEqual({
			orderId: "o-1",
			lines: [
				{ sku: "a", quantity: 1 },
				{ sku: "b", quantity: 2 },
			],
		});
	});

	it("freezes the payload and leaves the caller's objects unfrozen", () => {
		const input = placeOrder();
		const when = new Date("2031-01-02T03:04:05.000Z");
		const passed = { at: when, tags: new Set(["x"]) };

		const ordered = createDomainEvent(OrderPlaced, input);
		const happened = createDomainEvent(anything, passed);

		expect(Object.isFrozen(ordered.payload)).toBe(true);
		expect(Object.isFrozen(ordered.payload.lines[0])).toBe(true);
		expect(Object.isFrozen(input)).toBe(false);
		expect(Object.isFrozen(when)).toBe(false);
		expect(happened.payload).toEqual(passed);
		expect(happened.payload).not.toBe(passed);
	});

	it("rejects a payload that fails its schema with the issues and their paths", () => {
		const rejection = rejectionOf(() =>
			createDomainEvent(OrderPlaced, {
				orderId: "o-1",
				lines: [
					{ sku: "a", quantity: 1 },
					{ sku: "b", quantity: "two" as unknown as number },
				],
			}),
		);

		expect(rejection).toBeInstanceOf(DomainEventValidationError);
		expect(rejection).toMatchObject({
			code: "EVENT_PAYLOAD_INVALID",
			field: "payload",
			issues: [
				{
					message: "quantity must be a number",
					path: ["lines", 1, "quantity"],
				},
			],
		});
	});

	it("rejects a schema that validates asynchronously", () => {
		const later = defineDomainEvent("CheckedLater", {
			payload: standardSchema<unknown, unknown>(async (value) => ({ value })),
		});

		const rejection = rejectionOf(() => createDomainEvent(later, {}));

		expect(rejection).toMatchObject({
			code: "EVENT_PAYLOAD_SCHEMA_ASYNC",
			field: "payload",
		});
	});

	it("rejects schema output that is no plain data and names its path", () => {
		class Money {
			constructor(readonly cents: number) {}
		}
		const outputs = [
			{ price: new Money(100) },
			{ bytes: new Uint8Array([1]) },
			{ pattern: /a/ },
			{ callback: () => "no data" },
			{ nested: [{ deep: new Map([["k", new Money(1)]]) }] },
		];

		for (const output of outputs) {
			const rejection = rejectionOf(() => createDomainEvent(anything, output));

			expect(rejection).toBeInstanceOf(TypeError);
			expect(rejection).not.toBeInstanceOf(DomainEventValidationError);
		}
	});

	it("rejects a schema version in the options, because the definition owns it", () => {
		const rejection = rejectionOf(() =>
			createDomainEvent(OrderPlaced, placeOrder(), {
				schemaVersion: 3,
			} as never),
		);

		expect(rejection).toMatchObject({ code: "EVENT_SCHEMA_VERSION_INVALID" });
	});

	it("does not take a definition that defineDomainEvent did not build", () => {
		const handBuilt = {
			type: "OrderPlaced",
			schemaVersion: 1,
			payload: orderPlacedSchema,
		};

		const rejection = rejectionOf(() =>
			createDomainEvent(handBuilt as never, placeOrder()),
		);

		expect(rejection).toMatchObject({ code: "EVENT_TYPE_INVALID" });
	});

	it("builds through an event factory and with explicit envelope facts", () => {
		const factory = createDomainEventFactory({ eventIdFactory: () => "evt-1" });
		const occurredAt = new Date("2031-01-02T03:04:05.000Z");

		const fromFactory = factory.create(OrderPlaced, placeOrder());
		const explicit = createStampedDomainEvent(OrderPlaced, placeOrder(), {
			eventId: "evt-2",
			occurredAt,
		});

		expect(fromFactory).toMatchObject({ eventId: "evt-1", schemaVersion: 2 });
		expect(explicit).toMatchObject({ eventId: "evt-2", schemaVersion: 2 });
		expect(explicit.payload.lines).toHaveLength(2);
	});

	it("types the event by the output and the call by the input of the schema", () => {
		expectTypeOf<DomainEventOf<typeof OrderPlaced>>().toEqualTypeOf<
			DomainEvent<"OrderPlaced", OrderPlacedPayload>
		>();
		expectTypeOf(createDomainEvent(OrderPlaced, placeOrder())).toEqualTypeOf<
			DomainEvent<"OrderPlaced", OrderPlacedPayload>
		>();
	});
});

describe("an aggregate that creates an event from a definition", () => {
	type OrderEvent = DomainEventOf<typeof OrderPlaced>;
	type OrderId = Id<"OrderId">;

	class Order extends StateStoredAggregate<
		{ readonly placed: boolean },
		OrderId,
		OrderEvent
	> {
		protected readonly aggregateType = "Order";

		constructor(id: OrderId) {
			super(id, { placed: false });
		}

		place(input: OrderPlacedInput): void {
			this.setState({ placed: true }, this.createEvent(OrderPlaced, input));
		}
	}

	class OrderHistory extends EventSourcedAggregate<
		{ readonly lineCount: number },
		OrderId,
		OrderEvent
	> {
		protected readonly aggregateType = "Order";
		protected readonly folds = {
			OrderPlaced: (
				state: { readonly lineCount: number },
				event: { readonly payload: OrderPlacedPayload },
			) => ({ lineCount: state.lineCount + event.payload.lines.length }),
		};

		constructor(id: OrderId) {
			super(id, { lineCount: 0 });
		}

		place(input: OrderPlacedInput): void {
			this.apply(this.createEvent(OrderPlaced, input));
		}

		get lineCount(): number {
			return this.state.lineCount;
		}
	}

	it("attributes the event to the aggregate and takes the version of the definition", () => {
		const order = new Order("o-1" as OrderId);

		order.place(placeOrder());

		const [decision] = order.pendingEvents;
		expect(decision).toMatchObject({
			type: "OrderPlaced",
			aggregateId: "o-1",
			aggregateType: "Order",
			schemaVersion: 2,
		});
		expect(decision).not.toHaveProperty("eventId");
		expect(order.version).toBe(1 as Version);
	});

	it("folds the schema output in an event-sourced aggregate", () => {
		const history = new OrderHistory("o-1" as OrderId);

		history.place(placeOrder());

		expect(history.lineCount).toBe(2);
		expect(history.pendingEvents[0]?.payload).toEqual({
			orderId: "o-1",
			lines: [
				{ sku: "a", quantity: 1 },
				{ sku: "b", quantity: 2 },
			],
		});
	});
});
