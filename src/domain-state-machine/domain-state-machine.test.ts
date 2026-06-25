import { isBaseError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import { DomainError } from "../core/errors";
import {
	DomainStateMachine,
	InvalidDomainMachineDefinitionError,
	InvalidDomainMachineEventError,
	InvalidDomainMachineSnapshotError,
	InvalidDomainTransitionResultError,
	InvalidDomainTransitionError,
	DomainTransitionGuardRejectedError,
	canTransitionDomainState,
	createInitialDomainMachineSnapshot,
	transitionDomainState,
	type DomainMachineDefinition,
	type DomainMachineSnapshot,
} from "./domain-state-machine";

type CheckoutState =
	| "awaiting-payment"
	| "awaiting-shipping"
	| "completed"
	| "cancelled";

type CheckoutContext = {
	readonly orderId: string;
	readonly totalCents: number;
	readonly paymentId?: string;
	readonly shipmentId?: string;
};

type PaymentRequested = {
	readonly type: "PaymentRequested";
	readonly paymentId: string;
};

type PaymentReceived = {
	readonly type: "PaymentReceived";
};

type ShippingRequested = {
	readonly type: "ShippingRequested";
	readonly shipmentId: string;
};

type ShippingCompleted = {
	readonly type: "ShippingCompleted";
};

type Cancel = {
	readonly type: "Cancel";
	readonly reason: string;
};

type CheckoutEvent =
	| PaymentRequested
	| PaymentReceived
	| ShippingRequested
	| ShippingCompleted
	| Cancel;

type CheckoutOutput =
	| { readonly type: "RequestShipping"; readonly orderId: string }
	| { readonly type: "ConfirmOrder"; readonly orderId: string }
	| {
			readonly type: "CancelOrder";
			readonly orderId: string;
			readonly reason: string;
	  };

function checkoutDefinition(): DomainMachineDefinition<
	CheckoutState,
	CheckoutContext,
	CheckoutEvent,
	CheckoutOutput
> {
	return {
		initial: "awaiting-payment",
		initialContext: () => ({ orderId: "order-1", totalCents: 1000 }),
		states: {
			"awaiting-payment": {
				on: {
					PaymentRequested: {
						target: "awaiting-payment",
						reduce: ({ context, event }) => ({
							context: { ...context, paymentId: event.paymentId },
						}),
					},
					PaymentReceived: {
						target: "awaiting-shipping",
						guard: ({ context }) => context.paymentId !== undefined,
						reduce: ({ context }) => ({
							outputs: [{ type: "RequestShipping", orderId: context.orderId }],
						}),
					},
					Cancel: {
						target: "cancelled",
						reduce: ({ context, event }) => ({
							outputs: [
								{
									type: "CancelOrder",
									orderId: context.orderId,
									reason: event.reason,
								},
							],
						}),
					},
				},
			},
			"awaiting-shipping": {
				on: {
					ShippingRequested: {
						target: "awaiting-shipping",
						reduce: ({ context, event }) => ({
							context: { ...context, shipmentId: event.shipmentId },
						}),
					},
					ShippingCompleted: {
						target: "completed",
						reduce: ({ context }) => ({
							outputs: [{ type: "ConfirmOrder", orderId: context.orderId }],
						}),
					},
					Cancel: { target: "cancelled" },
				},
			},
			completed: { terminal: true },
			cancelled: { terminal: true },
		},
	};
}

describe("DomainStateMachine", () => {
	it("creates a fresh initial snapshot from the definition", () => {
		const definition = checkoutDefinition();

		const a = createInitialDomainMachineSnapshot(definition);
		const b = createInitialDomainMachineSnapshot(definition);

		expect(a).toEqual({
			state: "awaiting-payment",
			context: { orderId: "order-1", totalCents: 1000 },
		});
		expect(a.context).not.toBe(b.context);
	});

	it("reconstitutes a machine from a valid snapshot", () => {
		const machine = new DomainStateMachine(checkoutDefinition(), {
			state: "awaiting-shipping",
			context: {
				orderId: "order-1",
				totalCents: 1000,
				paymentId: "payment-1",
			},
		});

		expect(machine.snapshot).toEqual({
			state: "awaiting-shipping",
			context: {
				orderId: "order-1",
				totalCents: 1000,
				paymentId: "payment-1",
			},
		});
		expect(machine.state).toBe("awaiting-shipping");
		expect(machine.context.paymentId).toBe("payment-1");
	});

	it("rejects a snapshot whose state is not in the definition", () => {
		expect(
			() =>
				new DomainStateMachine(checkoutDefinition(), {
					state: "lost" as CheckoutState,
					context: { orderId: "order-1", totalCents: 1000 },
				}),
		).toThrow(InvalidDomainMachineSnapshotError);
	});

	it("throws structured errors for malformed runtime snapshots", () => {
		const definition = checkoutDefinition();
		const malformedSnapshots = [
			null,
			undefined,
			{},
			{ state: "awaiting-payment" },
			{ state: 123, context: { orderId: "order-1", totalCents: 1000 } },
		];

		for (const snapshot of malformedSnapshots) {
			expect(() =>
				transitionDomainState(
					definition,
					snapshot as unknown as DomainMachineSnapshot<
						CheckoutState,
						CheckoutContext
					>,
					{ type: "PaymentReceived" },
				),
			).toThrow(InvalidDomainMachineSnapshotError);
			expect(
				() =>
					new DomainStateMachine(
						definition,
						snapshot as unknown as DomainMachineSnapshot<
							CheckoutState,
							CheckoutContext
						>,
					),
			).toThrow(InvalidDomainMachineSnapshotError);
		}
	});

	it("rejects definitions with missing initial states or unknown targets", () => {
		expect(
			() =>
				new DomainStateMachine({
					...checkoutDefinition(),
					initial: "missing" as CheckoutState,
				}),
		).toThrow(InvalidDomainMachineDefinitionError);

		expect(
			() =>
				new DomainStateMachine({
					...checkoutDefinition(),
					states: {
						...checkoutDefinition().states,
						"awaiting-payment": {
							on: {
								PaymentReceived: {
									target: "missing" as CheckoutState,
								},
							},
						},
					},
				}),
		).toThrow(InvalidDomainMachineDefinitionError);
	});

	it("reports can=false when a transition is missing or a guard rejects it", () => {
		const definition = checkoutDefinition();
		const snapshot = createInitialDomainMachineSnapshot(definition);

		expect(
			canTransitionDomainState(definition, snapshot, {
				type: "ShippingCompleted",
			}),
		).toBe(false);
		expect(
			canTransitionDomainState(definition, snapshot, {
				type: "PaymentReceived",
			}),
		).toBe(false);
	});

	it("updates state and context through the pure transition function", () => {
		const definition = checkoutDefinition();
		const initial = createInitialDomainMachineSnapshot(definition);

		const result = transitionDomainState(definition, initial, {
			type: "PaymentRequested",
			paymentId: "payment-1",
		});

		expect(result).toEqual({
			from: "awaiting-payment",
			to: "awaiting-payment",
			snapshot: {
				state: "awaiting-payment",
				context: {
					orderId: "order-1",
					totalCents: 1000,
					paymentId: "payment-1",
				},
			},
			outputs: [],
		});
		expect(initial.context).toEqual({ orderId: "order-1", totalCents: 1000 });
	});

	it("keeps the previous context when reduce returns no context", () => {
		const definition = checkoutDefinition();
		const initial = createInitialDomainMachineSnapshot(definition);

		const result = transitionDomainState(definition, initial, {
			type: "Cancel",
			reason: "payment-failed",
		});

		expect(result.to).toBe("cancelled");
		expect(result.snapshot.context).toBe(initial.context);
		expect(result.outputs).toEqual([
			{
				type: "CancelOrder",
				orderId: "order-1",
				reason: "payment-failed",
			},
		]);
	});

	it("preserves explicit null and undefined context updates", () => {
		type NullableState = "filled" | "empty";
		type NullableContext = string | null | undefined;
		type NullableEvent =
			| { readonly type: "ClearToNull" }
			| { readonly type: "ClearToUndefined" };
		const definition: DomainMachineDefinition<
			NullableState,
			NullableContext,
			NullableEvent
		> = {
			initial: "filled",
			initialContext: () => "value",
			states: {
				filled: {
					on: {
						ClearToNull: {
							target: "empty",
							reduce: () => ({ context: null }),
						},
						ClearToUndefined: {
							target: "empty",
							reduce: () => ({ context: undefined }),
						},
					},
				},
				empty: { terminal: true },
			},
		};
		const initial = createInitialDomainMachineSnapshot(definition);

		expect(
			transitionDomainState(definition, initial, {
				type: "ClearToNull",
			}).snapshot.context,
		).toBeNull();
		expect(
			transitionDomainState(definition, initial, {
				type: "ClearToUndefined",
			}).snapshot.context,
		).toBeUndefined();
	});

	it("throws domain errors for missing or guard-rejected transitions", () => {
		const definition = checkoutDefinition();
		const snapshot = createInitialDomainMachineSnapshot(definition);

		expect(() =>
			transitionDomainState(definition, snapshot, {
				type: "ShippingCompleted",
			}),
		).toThrow(InvalidDomainTransitionError);

		expect(() =>
			transitionDomainState(definition, snapshot, {
				type: "PaymentReceived",
			}),
		).toThrow(DomainTransitionGuardRejectedError);
	});

	it("blocks transitions from terminal states", () => {
		const definition = checkoutDefinition();
		const completed: DomainMachineSnapshot<CheckoutState, CheckoutContext> = {
			state: "completed",
			context: { orderId: "order-1", totalCents: 1000 },
		};

		expect(
			canTransitionDomainState(definition, completed, {
				type: "Cancel",
				reason: "too-late",
			}),
		).toBe(false);
		expect(() =>
			transitionDomainState(definition, completed, {
				type: "Cancel",
				reason: "too-late",
			}),
		).toThrow(InvalidDomainTransitionError);
	});

	it("rejects runtime event names inherited from Object.prototype", () => {
		const machine = new DomainStateMachine(checkoutDefinition());

		for (const type of ["toString", "constructor", "__proto__"]) {
			const event = { type } as CheckoutEvent;

			expect(machine.can(event)).toBe(false);
			expect(() => machine.dispatch(event)).toThrow(
				InvalidDomainTransitionError,
			);
			expect(machine.state).toBe("awaiting-payment");
		}
	});

	it("preserves own __proto__ transition keys through wrapper definition copies", () => {
		const definition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly value: string },
			{ readonly type: "__proto__" }
		> = {
			initial: "open",
			initialContext: () => ({ value: "initial" }),
			states: {
				open: {
					on: {
						["__proto__"]: {
							target: "closed",
							reduce: ({ context }) => ({
								context: { ...context, value: "transitioned" },
							}),
						},
					},
				},
				closed: { terminal: true },
			},
		};

		expect(
			transitionDomainState(
				definition,
				createInitialDomainMachineSnapshot(definition),
				{ type: "__proto__" },
			).to,
		).toBe("closed");

		const machine = new DomainStateMachine(definition);
		const result = machine.dispatch({ type: "__proto__" });

		expect(result.to).toBe("closed");
		expect(result.snapshot.context.value).toBe("transitioned");
	});

	it("preserves own __proto__ state keys through wrapper definition copies", () => {
		const definition: DomainMachineDefinition<
			"__proto__" | "closed",
			{ readonly value: string },
			{ readonly type: "Close" }
		> = {
			initial: "__proto__",
			initialContext: () => ({ value: "initial" }),
			states: {
				["__proto__"]: {
					on: {
						Close: {
							target: "closed",
							reduce: ({ context }) => ({
								context: { ...context, value: "transitioned" },
							}),
						},
					},
				},
				closed: { terminal: true },
			},
		};

		const machine = new DomainStateMachine(definition);
		const result = machine.dispatch({ type: "Close" });

		expect(result.from).toBe("__proto__");
		expect(result.to).toBe("closed");
		expect(result.snapshot.context.value).toBe("transitioned");
	});

	it("throws structured definition errors for malformed runtime definitions", () => {
		const malformedDefinitions = [
			{
				initial: "open",
				initialContext: () => ({}),
				states: undefined,
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: { open: undefined },
			},
			{
				initial: "open",
				initialContext: "not-a-function",
				states: { open: {} },
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: { open: { on: "not-an-object" } },
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: { open: { on: { Close: undefined } } },
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: { open: { on: { Close: { target: undefined } } } },
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: { open: { terminal: "true" } },
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: { open: { on: { Close: { target: "open", guard: "yes" } } } },
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: {
					open: { on: { Close: { target: "open", reduce: "yes" } } },
				},
			},
		];

		for (const definition of malformedDefinitions) {
			expect(() => {
				new DomainStateMachine(
					definition as unknown as DomainMachineDefinition<
						"open",
						Record<string, never>,
						{ readonly type: "Close" }
					>,
				);
			}).toThrow(InvalidDomainMachineDefinitionError);
		}
	});

	it("returns false or throws structured errors for malformed runtime events", () => {
		const machine = new DomainStateMachine(checkoutDefinition());
		const malformedEvents = [null, undefined, {}, { type: 123 }];

		for (const event of malformedEvents) {
			expect(machine.can(event as unknown as CheckoutEvent)).toBe(false);
			expect(() => machine.dispatch(event as unknown as CheckoutEvent)).toThrow(
				InvalidDomainMachineEventError,
			);
		}
	});

	it("throws structured errors for malformed reducer results", () => {
		const malformedResults = [
			null,
			"invalid",
			{ outputs: "not-an-array" },
			{ outputs: 123 },
		];

		for (const malformedResult of malformedResults) {
			const definition: DomainMachineDefinition<
				"open" | "closed",
				Record<string, never>,
				{ readonly type: "Close" },
				{ readonly type: "Closed" }
			> = {
				initial: "open",
				initialContext: () => ({}),
				states: {
					open: {
						on: {
							Close: {
								target: "closed",
								reduce: () =>
									malformedResult as unknown as {
										readonly outputs?: readonly { readonly type: "Closed" }[];
									},
							},
						},
					},
					closed: { terminal: true },
				},
			};

			expect(() =>
				transitionDomainState(
					definition,
					createInitialDomainMachineSnapshot(definition),
					{ type: "Close" },
				),
			).toThrow(InvalidDomainTransitionResultError);
		}
	});

	it("mutates only the wrapper's current snapshot", () => {
		const machine = new DomainStateMachine(checkoutDefinition());

		const first = machine.dispatch({
			type: "PaymentRequested",
			paymentId: "payment-1",
		});
		const second = machine.dispatch({ type: "PaymentReceived" });

		expect(first.to).toBe("awaiting-payment");
		expect(second).toEqual({
			from: "awaiting-payment",
			to: "awaiting-shipping",
			snapshot: {
				state: "awaiting-shipping",
				context: {
					orderId: "order-1",
					totalCents: 1000,
					paymentId: "payment-1",
				},
			},
			outputs: [{ type: "RequestShipping", orderId: "order-1" }],
		});
		expect(machine.snapshot).toEqual(second.snapshot);
	});

	it("does not expose its internal snapshot reference through the snapshot getter", () => {
		const machine = new DomainStateMachine(checkoutDefinition());
		const exposed = machine.snapshot;

		expect(Object.isFrozen(exposed)).toBe(true);
		expect(() => {
			(exposed as { state: CheckoutState }).state = "completed";
		}).toThrow();

		expect(machine.state).toBe("awaiting-payment");
		expect(machine.snapshot).not.toBe(exposed);
	});

	it("does not expose its internal snapshot through dispatch results", () => {
		const machine = new DomainStateMachine(checkoutDefinition());
		const result = machine.dispatch({
			type: "PaymentRequested",
			paymentId: "payment-1",
		});

		expect(Object.isFrozen(result.snapshot)).toBe(true);
		expect(() => {
			(result.snapshot as { state: CheckoutState }).state = "completed";
		}).toThrow();

		expect(machine.state).toBe("awaiting-payment");
		expect(machine.context.paymentId).toBe("payment-1");
	});

	it("copies reconstitution snapshots so caller mutation cannot corrupt the wrapper", () => {
		const snapshot: DomainMachineSnapshot<CheckoutState, CheckoutContext> = {
			state: "awaiting-shipping",
			context: {
				orderId: "order-1",
				totalCents: 1000,
				paymentId: "payment-1",
			},
		};
		const machine = new DomainStateMachine(checkoutDefinition(), snapshot);

		(snapshot as { state: CheckoutState }).state = "completed";

		expect(machine.state).toBe("awaiting-shipping");
	});

	it("copies the wrapper definition so later caller mutation cannot alter behavior", () => {
		const definition = checkoutDefinition();
		const machine = new DomainStateMachine(definition);
		const paymentRequested = definition.states["awaiting-payment"].on
			?.PaymentRequested as { target: CheckoutState };

		paymentRequested.target = "completed";

		const result = machine.dispatch({
			type: "PaymentRequested",
			paymentId: "payment-1",
		});

		expect(result.to).toBe("awaiting-payment");
		expect(machine.state).toBe("awaiting-payment");
	});

	it("copies and freezes transition output arrays", () => {
		const outputs: CheckoutOutput[] = [
			{ type: "RequestShipping", orderId: "order-1" },
		];
		const definition: DomainMachineDefinition<
			CheckoutState,
			CheckoutContext,
			CheckoutEvent,
			CheckoutOutput
		> = {
			...checkoutDefinition(),
			states: {
				...checkoutDefinition().states,
				"awaiting-payment": {
					on: {
						PaymentRequested: {
							target: "awaiting-shipping",
							reduce: () => ({ outputs }),
						},
					},
				},
			},
		};

		const result = transitionDomainState(
			definition,
			createInitialDomainMachineSnapshot(definition),
			{ type: "PaymentRequested", paymentId: "payment-1" },
		);

		expect(result.outputs).toEqual(outputs);
		expect(result.outputs).not.toBe(outputs);
		expect(Object.isFrozen(result.outputs)).toBe(true);
		expect(() => {
			(result.outputs as CheckoutOutput[]).push({
				type: "ConfirmOrder",
				orderId: "order-1",
			});
		}).toThrow();
	});

	it("uses BaseError/DomainError hierarchy consistently", () => {
		const invalid = new InvalidDomainTransitionError("completed", "Cancel");
		const rejected = new DomainTransitionGuardRejectedError(
			"awaiting-payment",
			"PaymentReceived",
		);
		const badDefinition = new InvalidDomainMachineDefinitionError("bad");
		const badSnapshot = new InvalidDomainMachineSnapshotError("bad");
		const badEvent = new InvalidDomainMachineEventError("bad");
		const badResult = new InvalidDomainTransitionResultError("bad");

		expect(invalid).toBeInstanceOf(DomainError);
		expect(rejected).toBeInstanceOf(DomainError);
		expect(badDefinition).not.toBeInstanceOf(DomainError);
		expect(badSnapshot).not.toBeInstanceOf(DomainError);
		expect(badEvent).not.toBeInstanceOf(DomainError);
		expect(badResult).not.toBeInstanceOf(DomainError);
		expect(isBaseError(invalid)).toBe(true);
		expect(isBaseError(rejected)).toBe(true);
		expect(isBaseError(badDefinition)).toBe(true);
		expect(isBaseError(badSnapshot)).toBe(true);
		expect(isBaseError(badEvent)).toBe(true);
		expect(isBaseError(badResult)).toBe(true);
	});

	it("types transition callbacks to the event selected by the on-key", () => {
		const definition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly seen: string[] },
			| { readonly type: "Named"; readonly name: string }
			| { readonly type: "Numbered"; readonly value: number },
			never
		> = {
			initial: "open",
			initialContext: () => ({ seen: [] }),
			states: {
				open: {
					on: {
						Named: {
							target: "closed",
							reduce: ({ context, event }) => ({
								context: { seen: [...context.seen, event.name] },
							}),
						},
						Numbered: {
							target: "closed",
							guard: ({ event }) => event.value > 0,
						},
					},
				},
				closed: { terminal: true },
			},
		};

		expect(definition.states.open.on?.Named?.target).toBe("closed");

		type InvalidDefinition = DomainMachineDefinition<
			"open",
			{ readonly seen: string[] },
			// @ts-expect-error Event union members must carry a string type.
			{ readonly type: 123 },
			never
		>;
		void (null as unknown as InvalidDefinition);
	});
});
