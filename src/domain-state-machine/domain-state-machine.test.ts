import { isBaseError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import { DomainError } from "../core/errors";
import {
	DomainStateMachine,
	InvalidDomainMachineDefinitionError,
	InvalidDomainMachineContextError,
	InvalidDomainMachineEventError,
	InvalidDomainMachineSnapshotError,
	InvalidDomainTransitionGuardResultError,
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

	it("rejects runtime snapshot accessors without invoking them", () => {
		const definition = checkoutDefinition();
		const stateAccessorSnapshot: Record<PropertyKey, unknown> = {};
		const contextAccessorSnapshot: Record<PropertyKey, unknown> = {};
		let stateAccessorInvoked = false;
		let contextAccessorInvoked = false;

		Object.defineProperty(stateAccessorSnapshot, "state", {
			enumerable: true,
			get: () => {
				stateAccessorInvoked = true;
				throw new Error("state getter must not run");
			},
		});
		Object.defineProperty(stateAccessorSnapshot, "context", {
			enumerable: true,
			value: { orderId: "order-1", totalCents: 1000 },
		});
		Object.defineProperty(contextAccessorSnapshot, "state", {
			enumerable: true,
			value: "awaiting-payment",
		});
		Object.defineProperty(contextAccessorSnapshot, "context", {
			enumerable: true,
			get: () => {
				contextAccessorInvoked = true;
				throw new Error("context getter must not run");
			},
		});

		for (const snapshot of [stateAccessorSnapshot, contextAccessorSnapshot]) {
			expect(() =>
				canTransitionDomainState(
					definition,
					snapshot as DomainMachineSnapshot<CheckoutState, CheckoutContext>,
					{ type: "PaymentReceived" },
				),
			).toThrow(InvalidDomainMachineSnapshotError);
			expect(() =>
				transitionDomainState(
					definition,
					snapshot as DomainMachineSnapshot<CheckoutState, CheckoutContext>,
					{ type: "PaymentReceived" },
				),
			).toThrow(InvalidDomainMachineSnapshotError);
			expect(
				() =>
					new DomainStateMachine(
						definition,
						snapshot as DomainMachineSnapshot<CheckoutState, CheckoutContext>,
					),
			).toThrow(InvalidDomainMachineSnapshotError);
		}

		expect(stateAccessorInvoked).toBe(false);
		expect(contextAccessorInvoked).toBe(false);
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

	it("rejects definition accessors without invoking them", () => {
		const definitionWithInitialAccessor = {};
		const definitionWithStatesAccessor = {};
		const definitionWithTransitionAccessor = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Close: {},
					},
				},
				closed: { terminal: true },
			},
		};
		let initialAccessorInvoked = false;
		let statesAccessorInvoked = false;
		let transitionAccessorInvoked = false;

		Object.defineProperty(definitionWithInitialAccessor, "initial", {
			enumerable: true,
			get: () => {
				initialAccessorInvoked = true;
				throw new Error("initial getter must not run");
			},
		});
		Object.defineProperty(definitionWithInitialAccessor, "initialContext", {
			enumerable: true,
			value: () => ({}),
		});
		Object.defineProperty(definitionWithInitialAccessor, "states", {
			enumerable: true,
			value: { open: {} },
		});
		Object.defineProperty(definitionWithStatesAccessor, "initial", {
			enumerable: true,
			value: "open",
		});
		Object.defineProperty(definitionWithStatesAccessor, "initialContext", {
			enumerable: true,
			value: () => ({}),
		});
		Object.defineProperty(definitionWithStatesAccessor, "states", {
			enumerable: true,
			get: () => {
				statesAccessorInvoked = true;
				throw new Error("states getter must not run");
			},
		});
		Object.defineProperty(
			definitionWithTransitionAccessor.states.open.on.Close,
			"target",
			{
				enumerable: true,
				get: () => {
					transitionAccessorInvoked = true;
					throw new Error("target getter must not run");
				},
			},
		);

		for (const definition of [
			definitionWithInitialAccessor,
			definitionWithStatesAccessor,
			definitionWithTransitionAccessor,
		]) {
			expect(
				() =>
					new DomainStateMachine(
						definition as DomainMachineDefinition<
							"open" | "closed",
							Record<string, never>,
							{ readonly type: "Close" }
						>,
					),
			).toThrow(InvalidDomainMachineDefinitionError);
		}

		expect(initialAccessorInvoked).toBe(false);
		expect(statesAccessorInvoked).toBe(false);
		expect(transitionAccessorInvoked).toBe(false);
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

	it("reports can=false for forbidden transitions before validating unused event payloads", () => {
		const definition = checkoutDefinition();
		const snapshot = createInitialDomainMachineSnapshot(definition);
		const completed: DomainMachineSnapshot<CheckoutState, CheckoutContext> = {
			state: "completed",
			context: { orderId: "order-1", totalCents: 1000 },
		};

		expect(
			canTransitionDomainState(definition, snapshot, {
				type: "ShippingCompleted",
				callback: () => "not data",
			} as unknown as CheckoutEvent),
		).toBe(false);
		expect(
			canTransitionDomainState(definition, completed, {
				type: "Cancel",
				reason: "too-late",
				callback: () => "not data",
			} as unknown as CheckoutEvent),
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
		expect(result.snapshot.context).toEqual(initial.context);
		expect(result.snapshot.context).not.toBe(initial.context);
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

	it("throws structured errors when guards do not return booleans", () => {
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							guard: (() => undefined) as unknown as () => boolean,
						},
					},
				},
				closed: { terminal: true },
			},
		};
		const snapshot = createInitialDomainMachineSnapshot(definition);

		expect(() =>
			canTransitionDomainState(definition, snapshot, { type: "Close" }),
		).toThrow(InvalidDomainTransitionGuardResultError);
		expect(() =>
			transitionDomainState(definition, snapshot, { type: "Close" }),
		).toThrow(InvalidDomainTransitionGuardResultError);
	});

	it("throws invalid transition errors before validating unused event payloads", () => {
		const definition = checkoutDefinition();
		const snapshot = createInitialDomainMachineSnapshot(definition);
		const completed: DomainMachineSnapshot<CheckoutState, CheckoutContext> = {
			state: "completed",
			context: { orderId: "order-1", totalCents: 1000 },
		};

		expect(() =>
			transitionDomainState(definition, snapshot, {
				type: "ShippingCompleted",
				callback: () => "not data",
			} as unknown as CheckoutEvent),
		).toThrow(InvalidDomainTransitionError);
		expect(() =>
			transitionDomainState(definition, completed, {
				type: "Cancel",
				reason: "too-late",
				callback: () => "not data",
			} as unknown as CheckoutEvent),
		).toThrow(InvalidDomainTransitionError);
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

	it("rejects terminal state definitions with outgoing transitions", () => {
		const definition: DomainMachineDefinition<
			"closed" | "open",
			Record<string, never>,
			{ readonly type: "Reopen" }
		> = {
			initial: "closed",
			initialContext: () => ({}),
			states: {
				closed: {
					terminal: true,
					on: {
						Reopen: { target: "open" },
					},
				},
				open: {},
			},
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			InvalidDomainMachineDefinitionError,
		);
		expect(() => new DomainStateMachine(definition)).toThrow(
			InvalidDomainMachineDefinitionError,
		);
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

	it("rejects reducer result accessors without invoking them", () => {
		for (const accessorKey of ["context", "outputs"] as const) {
			let accessorInvoked = false;
			const resultWithAccessor: Record<PropertyKey, unknown> = {};
			Object.defineProperty(resultWithAccessor, accessorKey, {
				enumerable: true,
				get: () => {
					accessorInvoked = true;
					throw new Error(`${accessorKey} getter must not run`);
				},
			});
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
									resultWithAccessor as {
										readonly context?: Record<string, never>;
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
			expect(accessorInvoked).toBe(false);
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

	it("does not let context references mutate the wrapper outside transitions", () => {
		type GuardedState = "awaiting-payment" | "paid";
		type GuardedContext = {
			readonly payment: { readonly id?: string };
			readonly audit: readonly string[];
		};
		type GuardedEvent =
			| { readonly type: "SetPayment"; readonly paymentId: string }
			| { readonly type: "Pay" };
		const initialContext: GuardedContext = {
			payment: {},
			audit: ["created"],
		};
		let reducerContext: GuardedContext | undefined;
		const definition: DomainMachineDefinition<
			GuardedState,
			GuardedContext,
			GuardedEvent
		> = {
			initial: "awaiting-payment",
			initialContext: () => initialContext,
			states: {
				"awaiting-payment": {
					on: {
						SetPayment: {
							target: "awaiting-payment",
							reduce: ({ context, event }) => {
								reducerContext = {
									payment: { id: event.paymentId },
									audit: [...context.audit, "payment-set"],
								};
								return { context: reducerContext };
							},
						},
						Pay: {
							target: "paid",
							guard: ({ context }) => context.payment.id !== undefined,
						},
					},
				},
				paid: { terminal: true },
			},
		};

		const machine = new DomainStateMachine(definition);

		(initialContext.payment as { id?: string }).id = "outside";
		expect(machine.can({ type: "Pay" })).toBe(false);
		expect(() => {
			(machine.context.payment as { id?: string }).id = "outside";
		}).toThrow();
		expect(() => {
			(machine.snapshot.context.audit as string[]).push("outside");
		}).toThrow();

		const setPayment = machine.dispatch({
			type: "SetPayment",
			paymentId: "payment-1",
		});

		expect(machine.can({ type: "Pay" })).toBe(true);
		expect(() => {
			(setPayment.snapshot.context.payment as { id?: string }).id = "outside";
		}).toThrow();
		(reducerContext?.payment as { id?: string }).id = "outside";
		expect(machine.context.payment.id).toBe("payment-1");
	});

	it("does not let reconstitution snapshot context mutation corrupt the wrapper", () => {
		type NestedContext = { readonly nested: { readonly value: string } };
		const snapshot: DomainMachineSnapshot<"open" | "closed", NestedContext> = {
			state: "open",
			context: { nested: { value: "initial" } },
		};
		const machine = new DomainStateMachine<
			"open" | "closed",
			NestedContext,
			{ readonly type: "Close" }
		>(
			{
				initial: "open",
				initialContext: () => ({ nested: { value: "new" } }),
				states: {
					open: {
						on: {
							Close: {
								target: "closed",
								guard: ({ context }) => context.nested.value === "initial",
							},
						},
					},
					closed: { terminal: true },
				},
			},
			snapshot,
		);

		(snapshot.context.nested as { value: string }).value = "mutated";

		expect(machine.can({ type: "Close" })).toBe(true);
		expect(machine.context.nested.value).toBe("initial");
	});

	it("does not let pure transition guards mutate caller-owned snapshot context", () => {
		type NestedContext = { readonly nested: { readonly allowed: boolean } };
		const snapshot: DomainMachineSnapshot<"open" | "closed", NestedContext> = {
			state: "open",
			context: { nested: { allowed: false } },
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			NestedContext,
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ nested: { allowed: false } }),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							guard: ({ context }) => {
								(context.nested as { allowed: boolean }).allowed = true;
								return true;
							},
						},
					},
				},
				closed: { terminal: true },
			},
		};

		expect(() =>
			canTransitionDomainState(definition, snapshot, { type: "Close" }),
		).toThrow(TypeError);
		expect(snapshot.context.nested.allowed).toBe(false);
	});

	it("does not let pure transition reducers mutate caller-owned snapshot context", () => {
		type AuditContext = { readonly audit: readonly string[] };
		const snapshot: DomainMachineSnapshot<"open" | "closed", AuditContext> = {
			state: "open",
			context: { audit: [] },
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			AuditContext,
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ audit: [] }),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: ({ context }) => {
								(context.audit as string[]).push("mutated");
								return undefined;
							},
						},
					},
				},
				closed: { terminal: true },
			},
		};

		expect(() =>
			transitionDomainState(definition, snapshot, { type: "Close" }),
		).toThrow(TypeError);
		expect(snapshot.context.audit).toEqual([]);
	});

	it("does not let pure transition guards mutate caller-owned event data", () => {
		type EventWithPayload = {
			readonly type: "Check";
			readonly payload: { readonly allowed: boolean };
		};
		const event: EventWithPayload = {
			type: "Check",
			payload: { allowed: false },
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			EventWithPayload
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Check: {
							target: "closed",
							guard: ({ event }) => {
								(event.payload as { allowed: boolean }).allowed = true;
								return true;
							},
						},
					},
				},
				closed: { terminal: true },
			},
		};

		expect(() =>
			canTransitionDomainState(
				definition,
				createInitialDomainMachineSnapshot(definition),
				event,
			),
		).toThrow(TypeError);
		expect(event.payload.allowed).toBe(false);
	});

	it("does not let pure transition reducers mutate caller-owned event data", () => {
		type EventWithPayload = {
			readonly type: "Close";
			readonly payload: { readonly audit: readonly string[] };
		};
		const event: EventWithPayload = {
			type: "Close",
			payload: { audit: [] },
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			EventWithPayload
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: ({ event }) => {
								(event.payload.audit as string[]).push("mutated");
								return undefined;
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
				event,
			),
		).toThrow(TypeError);
		expect(event.payload.audit).toEqual([]);
	});

	it("preserves and freezes complex context graphs across snapshots", () => {
		const symbolKey = Symbol("context");
		type SharedValue = { value: string };
		type CyclicValue = { name: string; self?: CyclicValue };
		type ComplexContext = {
			readonly [symbolKey]: { readonly code: string };
			readonly shared: SharedValue;
			readonly lookup: ReadonlyMap<string, unknown>;
			readonly selected: ReadonlySet<unknown>;
			readonly cycle: CyclicValue;
		};
		const shared: SharedValue = { value: "initial" };
		const cycle: CyclicValue = { name: "root" };
		cycle.self = cycle;
		const originalContext: ComplexContext = {
			[symbolKey]: { code: "secret" },
			shared,
			lookup: new Map<string, unknown>([
				["shared", shared],
				["cycle", cycle],
			]),
			selected: new Set<unknown>([shared]),
			cycle,
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			ComplexContext,
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => originalContext,
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							guard: ({ context }) =>
								context.lookup.get("shared") === context.shared &&
								context.cycle.self === context.cycle &&
								context[symbolKey].code === "secret",
						},
					},
				},
				closed: { terminal: true },
			},
		};

		const machine = new DomainStateMachine(definition);
		const exposed = machine.context as ComplexContext;

		expect(exposed.lookup.get("shared")).toBe(exposed.shared);
		expect(exposed.cycle.self).toBe(exposed.cycle);
		expect(exposed[symbolKey].code).toBe("secret");
		expect(machine.can({ type: "Close" })).toBe(true);

		shared.value = "outside";
		expect(machine.context.shared.value).toBe("initial");
		expect(() =>
			(exposed.lookup as Map<string, unknown>).set("outside", "mutation"),
		).toThrow(TypeError);
		expect(() => (exposed.selected as Set<unknown>).add("mutation")).toThrow(
			TypeError,
		);
		expect(() => {
			(exposed[symbolKey] as { code: string }).code = "mutated";
		}).toThrow(TypeError);
	});

	it("rejects context values that cannot be made deeply immutable", () => {
		const invalidContexts = [
			{ callback: () => "not data" },
			{ bytes: new Uint8Array([1, 2, 3]) },
			{ buffer: new ArrayBuffer(8) },
			{ deferred: Promise.resolve("later") },
			{ weak: new WeakMap<object, string>() },
			{ weak: new WeakSet<object>() },
		];

		for (const context of invalidContexts) {
			const definition: DomainMachineDefinition<
				"open" | "closed",
				typeof context,
				{ readonly type: "Close" }
			> = {
				initial: "open",
				initialContext: () => context,
				states: {
					open: { on: { Close: { target: "closed" } } },
					closed: { terminal: true },
				},
			};

			expect(() => new DomainStateMachine(definition)).toThrow(
				InvalidDomainMachineContextError,
			);
		}
	});

	it("rejects context accessor properties because context must be data", () => {
		const getterContext = {};
		Object.defineProperty(getterContext, "value", {
			enumerable: true,
			get: () => "not data",
		});
		const setterContext = {};
		Object.defineProperty(setterContext, "value", {
			enumerable: true,
			set: () => {
				/* accessor presence is the invalid part */
			},
		});

		for (const context of [getterContext, setterContext]) {
			const definition: DomainMachineDefinition<
				"open" | "closed",
				typeof context,
				{ readonly type: "Close" }
			> = {
				initial: "open",
				initialContext: () => context,
				states: {
					open: { on: { Close: { target: "closed" } } },
					closed: { terminal: true },
				},
			};

			expect(() => new DomainStateMachine(definition)).toThrow(
				InvalidDomainMachineContextError,
			);
		}
	});

	it("rejects array accessor properties without invoking them", () => {
		const contextArray: unknown[] = [];
		const eventArray: unknown[] = [];
		const outputArray: unknown[] = [];
		let contextArrayAccessorInvoked = false;
		let eventArrayAccessorInvoked = false;
		let outputArrayAccessorInvoked = false;

		Object.defineProperty(contextArray, "0", {
			enumerable: true,
			get: () => {
				contextArrayAccessorInvoked = true;
				throw new Error("context array getter must not run");
			},
		});
		Object.defineProperty(eventArray, "0", {
			enumerable: true,
			get: () => {
				eventArrayAccessorInvoked = true;
				throw new Error("event array getter must not run");
			},
		});
		Object.defineProperty(outputArray, "0", {
			enumerable: true,
			get: () => {
				outputArrayAccessorInvoked = true;
				throw new Error("output array getter must not run");
			},
		});

		const contextDefinition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly items: readonly unknown[] },
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ items: contextArray }),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const eventDefinition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close"; readonly items: readonly unknown[] }
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const outputDefinition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close" },
			unknown
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: () => ({ outputs: outputArray }),
						},
					},
				},
				closed: { terminal: true },
			},
		};

		expect(() => new DomainStateMachine(contextDefinition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(() =>
			transitionDomainState(
				eventDefinition,
				createInitialDomainMachineSnapshot(eventDefinition),
				{ type: "Close", items: eventArray },
			),
		).toThrow(InvalidDomainMachineEventError);
		expect(() =>
			transitionDomainState(
				outputDefinition,
				createInitialDomainMachineSnapshot(outputDefinition),
				{ type: "Close" },
			),
		).toThrow(InvalidDomainTransitionResultError);

		expect(contextArrayAccessorInvoked).toBe(false);
		expect(eventArrayAccessorInvoked).toBe(false);
		expect(outputArrayAccessorInvoked).toBe(false);
	});

	it("rejects custom class instances because machine data must be plain data", () => {
		class SecretValue {
			#value: string;

			constructor(value: string) {
				this.#value = value;
			}

			get value(): string {
				return this.#value;
			}
		}
		class SecretMap extends Map<string, string> {}
		class SecretSet extends Set<string> {}

		const contextDefinition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly secret: SecretValue },
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ secret: new SecretValue("context") }),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const eventDefinition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close"; readonly secret: SecretValue }
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const outputDefinition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close" },
			SecretValue
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: () => ({ outputs: [new SecretValue("output")] }),
						},
					},
				},
				closed: { terminal: true },
			},
		};
		const mapDefinition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly secret: SecretMap },
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ secret: new SecretMap() }),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const setEventDefinition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close"; readonly secret: SecretSet }
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};

		expect(() => new DomainStateMachine(contextDefinition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(() => new DomainStateMachine(mapDefinition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(() =>
			transitionDomainState(
				eventDefinition,
				createInitialDomainMachineSnapshot(eventDefinition),
				{ type: "Close", secret: new SecretValue("event") },
			),
		).toThrow(InvalidDomainMachineEventError);
		expect(() =>
			transitionDomainState(
				setEventDefinition,
				createInitialDomainMachineSnapshot(setEventDefinition),
				{ type: "Close", secret: new SecretSet() },
			),
		).toThrow(InvalidDomainMachineEventError);
		expect(() =>
			transitionDomainState(
				outputDefinition,
				createInitialDomainMachineSnapshot(outputDefinition),
				{ type: "Close" },
			),
		).toThrow(InvalidDomainTransitionResultError);
	});

	it("rejects event values that cannot be made deeply immutable", () => {
		const invalidEvents = [
			{ type: "Close", callback: () => "not data" },
			{ type: "Close", bytes: new Uint8Array([1, 2, 3]) },
			{ type: "Close", deferred: Promise.resolve("later") },
			{ type: "Close", weak: new WeakMap<object, string>() },
		];

		for (const event of invalidEvents) {
			const definition: DomainMachineDefinition<
				"open" | "closed",
				Record<string, never>,
				typeof event
			> = {
				initial: "open",
				initialContext: () => ({}),
				states: {
					open: { on: { Close: { target: "closed" } } },
					closed: { terminal: true },
				},
			};

			expect(() =>
				transitionDomainState(
					definition,
					createInitialDomainMachineSnapshot(definition),
					event,
				),
			).toThrow(InvalidDomainMachineEventError);
		}
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

	it("copies and deeply freezes transition output values", () => {
		type NestedOutput = {
			readonly type: "Nested";
			readonly data: { value: string };
		};
		const output: NestedOutput = {
			type: "Nested",
			data: { value: "initial" },
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close" },
			NestedOutput
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: () => ({ outputs: [output] }),
						},
					},
				},
				closed: { terminal: true },
			},
		};

		const result = transitionDomainState(
			definition,
			createInitialDomainMachineSnapshot(definition),
			{ type: "Close" },
		);
		expect(result.outputs).toHaveLength(1);
		const [copiedOutput] = result.outputs as readonly [NestedOutput];

		output.data.value = "mutated-outside";
		expect(copiedOutput).toEqual({
			type: "Nested",
			data: { value: "initial" },
		});
		expect(copiedOutput).not.toBe(output);
		expect(() => {
			(copiedOutput.data as { value: string }).value = "mutated";
		}).toThrow(TypeError);
	});

	it("rejects transition output values that cannot be made deeply immutable", () => {
		const invalidOutputs = [
			{ callback: () => "not data" },
			{ bytes: new Uint8Array([1, 2, 3]) },
			{ deferred: Promise.resolve("later") },
			{ weak: new WeakSet<object>() },
		];

		for (const output of invalidOutputs) {
			const definition: DomainMachineDefinition<
				"open" | "closed",
				Record<string, never>,
				{ readonly type: "Close" },
				typeof output
			> = {
				initial: "open",
				initialContext: () => ({}),
				states: {
					open: {
						on: {
							Close: {
								target: "closed",
								reduce: () => ({ outputs: [output] }),
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

	it("uses BaseError/DomainError hierarchy consistently", () => {
		const invalid = new InvalidDomainTransitionError("completed", "Cancel");
		const rejected = new DomainTransitionGuardRejectedError(
			"awaiting-payment",
			"PaymentReceived",
		);
		const badDefinition = new InvalidDomainMachineDefinitionError("bad");
		const badContext = new InvalidDomainMachineContextError("bad");
		const badSnapshot = new InvalidDomainMachineSnapshotError("bad");
		const badEvent = new InvalidDomainMachineEventError("bad");
		const badGuard = new InvalidDomainTransitionGuardResultError("bad");
		const badResult = new InvalidDomainTransitionResultError("bad");

		expect(invalid).toBeInstanceOf(DomainError);
		expect(rejected).toBeInstanceOf(DomainError);
		expect(badDefinition).not.toBeInstanceOf(DomainError);
		expect(badContext).not.toBeInstanceOf(DomainError);
		expect(badSnapshot).not.toBeInstanceOf(DomainError);
		expect(badEvent).not.toBeInstanceOf(DomainError);
		expect(badGuard).not.toBeInstanceOf(DomainError);
		expect(badResult).not.toBeInstanceOf(DomainError);
		expect(isBaseError(invalid)).toBe(true);
		expect(isBaseError(rejected)).toBe(true);
		expect(isBaseError(badDefinition)).toBe(true);
		expect(isBaseError(badContext)).toBe(true);
		expect(isBaseError(badSnapshot)).toBe(true);
		expect(isBaseError(badEvent)).toBe(true);
		expect(isBaseError(badGuard)).toBe(true);
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

		const assertConstructorRejectsUndefined = () => {
			// @ts-expect-error Explicit undefined is not a valid reconstitution snapshot.
			new DomainStateMachine(definition, undefined);
		};
		void assertConstructorRejectsUndefined;
	});
});
