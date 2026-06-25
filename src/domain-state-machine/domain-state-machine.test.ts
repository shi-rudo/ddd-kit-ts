import { isBaseError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import { DomainError } from "../core/errors";
import {
	DomainStateMachine,
	InvalidDomainMachineDefinitionError,
	InvalidDomainMachineSnapshotError,
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

	it("uses BaseError/DomainError hierarchy consistently", () => {
		const invalid = new InvalidDomainTransitionError("completed", "Cancel");
		const rejected = new DomainTransitionGuardRejectedError(
			"awaiting-payment",
			"PaymentReceived",
		);
		const badDefinition = new InvalidDomainMachineDefinitionError("bad");
		const badSnapshot = new InvalidDomainMachineSnapshotError("bad");

		expect(invalid).toBeInstanceOf(DomainError);
		expect(rejected).toBeInstanceOf(DomainError);
		expect(badDefinition).not.toBeInstanceOf(DomainError);
		expect(badSnapshot).not.toBeInstanceOf(DomainError);
		expect(isBaseError(invalid)).toBe(true);
		expect(isBaseError(rejected)).toBe(true);
		expect(isBaseError(badDefinition)).toBe(true);
		expect(isBaseError(badSnapshot)).toBe(true);
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
