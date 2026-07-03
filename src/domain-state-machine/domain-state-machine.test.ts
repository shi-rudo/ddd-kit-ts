// @ts-expect-error Node's VM exists in the test runtime; the package stays Node-type-free.
import { runInNewContext } from "node:vm";
import { isBaseError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import { DomainError } from "../core/errors";
import {
	canTransitionDomainState,
	createInitialDomainMachineSnapshot,
	type DomainMachineDefinition,
	type DomainMachineInput,
	type DomainMachineSnapshot,
	DomainStateMachine,
	type DomainTransition,
	DomainTransitionGuardRejectedError,
	InvalidDomainMachineContextError,
	InvalidDomainMachineDefinitionError,
	InvalidDomainMachineInputError,
	InvalidDomainMachineSnapshotError,
	InvalidDomainTransitionError,
	InvalidDomainTransitionGuardResultError,
	InvalidDomainTransitionResultError,
	ReentrantDomainStateMachineEvaluationError,
	transitionDomainState,
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

type CheckoutInput =
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

class PaymentRequiredBeforeShippingError extends DomainError<"PaymentRequiredBeforeShippingError"> {
	constructor() {
		super("Payment is required before shipping.");
	}
}

function nestedRecord(depth: number): Record<string, unknown> {
	const root: Record<string, unknown> = {};
	let current = root;
	for (let index = 0; index < depth; index++) {
		const next: Record<string, unknown> = {};
		current.next = next;
		current = next;
	}
	return root;
}

function checkoutDefinition(): DomainMachineDefinition<
	CheckoutState,
	CheckoutContext,
	CheckoutInput,
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
						reduce: ({ context, input }) => ({
							context: { ...context, paymentId: input.paymentId },
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
						reduce: ({ context, input }) => ({
							outputs: [
								{
									type: "CancelOrder",
									orderId: context.orderId,
									reason: input.reason,
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
						reduce: ({ context, input }) => ({
							context: { ...context, shipmentId: input.shipmentId },
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
	it("exposes transition triggers as machine inputs", () => {
		const input: DomainMachineInput = { type: "Cancel" };

		expect(input.type).toBe("Cancel");
	});

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

	it("rejects initial snapshots that violate definition invariants", () => {
		const definition: DomainMachineDefinition<
			"open",
			{ readonly approved: boolean },
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => ({ approved: false }),
			validateSnapshot: ({ context }) => context.approved,
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			InvalidDomainMachineSnapshotError,
		);
	});

	it("rejects non-boolean snapshot validator results", () => {
		const invalidValidators = [() => undefined, async () => true];

		for (const validateSnapshot of invalidValidators) {
			const definition = {
				initial: "open",
				initialContext: () => ({}),
				validateSnapshot,
				states: { open: {} },
			} as unknown as DomainMachineDefinition<
				"open",
				Record<string, never>,
				{ readonly type: "Stay" }
			>;

			expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
				InvalidDomainMachineDefinitionError,
			);
		}
	});

	it("enforces context invariants declared by the active state", () => {
		const definition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly approved: boolean },
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ approved: false }),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: {
					terminal: true,
					validateContext: ({ state, context }) => {
						const closedState: "closed" = state;
						return closedState === "closed" && context.approved;
					},
				},
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(() => machine.dispatch({ type: "Close" })).toThrow(
			InvalidDomainMachineSnapshotError,
		);
		expect(machine.state).toBe("open");
	});

	it("evaluates each state-local invariant once per snapshot boundary", () => {
		const checks = { active: 0, done: 0 };
		const definition: DomainMachineDefinition<
			"active" | "done",
			{ readonly valid: boolean },
			{ readonly type: "Stay" } | { readonly type: "Finish" }
		> = {
			initial: "active",
			initialContext: () => ({ valid: true }),
			states: {
				active: {
					validateContext: ({ context }) => {
						checks.active += 1;
						return context.valid;
					},
					on: {
						Stay: { target: "active" },
						Finish: { target: "done" },
					},
				},
				done: {
					terminal: true,
					validateContext: ({ context }) => {
						checks.done += 1;
						return context.valid;
					},
				},
			},
		};

		const initial = createInitialDomainMachineSnapshot(definition);
		expect(checks).toEqual({ active: 1, done: 0 });

		const machine = new DomainStateMachine(definition, initial);
		expect(checks).toEqual({ active: 2, done: 0 });
		expect(machine.can({ type: "Stay" })).toBe(true);
		expect(checks).toEqual({ active: 2, done: 0 });

		machine.dispatch({ type: "Stay" });
		expect(checks).toEqual({ active: 3, done: 0 });

		expect(
			canTransitionDomainState(definition, initial, { type: "Stay" }),
		).toBe(true);
		expect(checks).toEqual({ active: 4, done: 0 });

		transitionDomainState(definition, initial, { type: "Stay" });
		expect(checks).toEqual({ active: 6, done: 0 });

		const finished = transitionDomainState(definition, initial, {
			type: "Finish",
		});
		expect(checks).toEqual({ active: 7, done: 1 });

		new DomainStateMachine(definition, finished.snapshot);
		expect(checks).toEqual({ active: 7, done: 2 });
	});

	it("treats an explicit undefined snapshot as no snapshot", () => {
		const definition: DomainMachineDefinition<
			"active" | "done",
			{ readonly value: number },
			{ readonly type: "Finish" }
		> = {
			initial: "active",
			initialContext: () => ({ value: 1 }),
			states: {
				active: { on: { Finish: { target: "done" } } },
				done: { terminal: true },
			},
		};

		// A nullable `repo.loadSnapshot(id)` / `map.get(id)` passed straight
		// through yields `undefined`, which must both typecheck against the
		// snapshot overload and behave like the zero-arg call, constructing a
		// fresh machine at the initial state instead of throwing.
		const restored:
			| DomainMachineSnapshot<"active" | "done", { readonly value: number }>
			| undefined = undefined;
		const machine = new DomainStateMachine(definition, restored);

		expect(machine.state).toBe("active");
		expect(machine.snapshot).toEqual({
			state: "active",
			context: { value: 1 },
		});
	});

	it("rejects invalid self-transition context without advancing the wrapper", () => {
		const definition: DomainMachineDefinition<
			"active",
			{ readonly valid: boolean },
			{ readonly type: "Invalidate" }
		> = {
			initial: "active",
			initialContext: () => ({ valid: true }),
			states: {
				active: {
					validateContext: ({ context }) => context.valid,
					on: {
						Invalidate: {
							target: "active",
							reduce: () => ({ context: { valid: false } }),
						},
					},
				},
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(() => machine.dispatch({ type: "Invalidate" })).toThrow(
			InvalidDomainMachineSnapshotError,
		);
		expect(machine.snapshot).toEqual({
			state: "active",
			context: { valid: true },
		});
	});

	it("rejects malformed state-local invariant definitions and results", () => {
		const malformedDefinition = {
			initial: "active",
			initialContext: () => ({}),
			states: { active: { validateContext: true } },
		} as unknown as DomainMachineDefinition<
			"active",
			Record<string, never>,
			{ readonly type: "Stay" }
		>;
		expect(() => new DomainStateMachine(malformedDefinition)).toThrow(
			InvalidDomainMachineDefinitionError,
		);

		const invalidResult: DomainMachineDefinition<
			"active",
			Record<string, never>,
			{ readonly type: "Stay" }
		> = {
			initial: "active",
			initialContext: () => ({}),
			states: {
				active: {
					validateContext: (() => undefined) as unknown as () => boolean,
				},
			},
		};
		expect(() => createInitialDomainMachineSnapshot(invalidResult)).toThrow(
			InvalidDomainMachineDefinitionError,
		);
	});

	it("validates each initial snapshot exactly once", () => {
		let validations = 0;
		const definition: DomainMachineDefinition<
			"open",
			Record<string, never>,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => ({}),
			validateSnapshot: () => {
				validations += 1;
				return true;
			},
			states: { open: {} },
		};

		new DomainStateMachine(definition);

		expect(validations).toBe(1);
	});

	it("passes copied and deeply frozen data to snapshot validators", () => {
		const originalContext = { nested: { approved: true } };
		const definition: DomainMachineDefinition<
			"open",
			typeof originalContext,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => originalContext,
			validateSnapshot: (snapshot) =>
				Object.isFrozen(snapshot) &&
				Object.isFrozen(snapshot.context) &&
				Object.isFrozen(snapshot.context.nested) &&
				snapshot.context !== originalContext,
			states: { open: {} },
		};

		expect(createInitialDomainMachineSnapshot(definition).state).toBe("open");
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

	it("rejects reconstitution snapshots that violate definition invariants", () => {
		const definition = {
			...checkoutDefinition(),
			validateSnapshot: (
				snapshot: DomainMachineSnapshot<CheckoutState, CheckoutContext>,
			) =>
				snapshot.state !== "awaiting-shipping" ||
				snapshot.context.paymentId !== undefined,
		} as unknown as DomainMachineDefinition<
			CheckoutState,
			CheckoutContext,
			CheckoutInput,
			CheckoutOutput
		>;

		expect(
			() =>
				new DomainStateMachine(definition, {
					state: "awaiting-shipping",
					context: { orderId: "order-1", totalCents: 1000 },
				}),
		).toThrow(InvalidDomainMachineSnapshotError);
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
		// `undefined` is excluded: the pure function has no "no snapshot"
		// overload and still rejects it (asserted separately below), while the
		// class constructor treats an explicit `undefined` as "no snapshot".
		const malformedSnapshots = [
			null,
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

		// The pure transition function requires a snapshot, so `undefined` is
		// still a malformed input for it (unlike the class constructor).
		expect(() =>
			transitionDomainState(
				definition,
				undefined as unknown as DomainMachineSnapshot<
					CheckoutState,
					CheckoutContext
				>,
				{ type: "PaymentReceived" },
			),
		).toThrow(InvalidDomainMachineSnapshotError);
	});

	it("validates pure API input snapshots before invoking callbacks", () => {
		let guardCalled = false;
		const definition: DomainMachineDefinition<
			"open",
			{ readonly approved: boolean },
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => ({ approved: true }),
			validateSnapshot: ({ context }) => context.approved,
			states: {
				open: {
					on: {
						Stay: {
							target: "open",
							guard: () => {
								guardCalled = true;
								return true;
							},
						},
					},
				},
			},
		};
		const invalidSnapshot = {
			state: "open" as const,
			context: { approved: false },
		};

		expect(() =>
			canTransitionDomainState(definition, invalidSnapshot, { type: "Stay" }),
		).toThrow(InvalidDomainMachineSnapshotError);
		expect(() =>
			transitionDomainState(definition, invalidSnapshot, { type: "Stay" }),
		).toThrow(InvalidDomainMachineSnapshotError);
		expect(guardCalled).toBe(false);
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

	it("reports can=false for forbidden transitions before validating unused input payloads", () => {
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
			} as unknown as CheckoutInput),
		).toBe(false);
		expect(
			canTransitionDomainState(definition, completed, {
				type: "Cancel",
				reason: "too-late",
				callback: () => "not data",
			} as unknown as CheckoutInput),
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

	it("reuses the wrapper's frozen context while evaluating guards", () => {
		type Context = { readonly nested: { readonly value: string } };
		let guardedContext: Context | undefined;
		const definition: DomainMachineDefinition<
			"open",
			Context,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => ({ nested: { value: "initial" } }),
			states: {
				open: {
					on: {
						Stay: {
							target: "open",
							guard: ({ context }) => {
								guardedContext = context;
								return true;
							},
						},
					},
				},
			},
		};
		const machine = new DomainStateMachine(definition);
		const contextBeforeCan = machine.context;

		expect(machine.can({ type: "Stay" })).toBe(true);
		expect(guardedContext).toBe(contextBeforeCan);
	});

	it("reuses the wrapper's frozen context when a transition does not replace it", () => {
		type Context = { readonly nested: { readonly value: string } };
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Context,
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ nested: { value: "initial" } }),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);
		const contextBeforeDispatch = machine.context;

		const result = machine.dispatch({ type: "Close" });

		expect(result.snapshot.context).toBe(contextBeforeDispatch);
		expect(machine.context).toBe(contextBeforeDispatch);
	});

	it("preserves explicit null and undefined context updates", () => {
		type NullableState = "filled" | "empty";
		type NullableContext = string | null | undefined;
		type NullableInput =
			| { readonly type: "ClearToNull" }
			| { readonly type: "ClearToUndefined" };
		const definition: DomainMachineDefinition<
			NullableState,
			NullableContext,
			NullableInput
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

	it("returns false for typed domain rejections and throws them on dispatch", () => {
		const rejection = new PaymentRequiredBeforeShippingError();
		let reduceCalled = false;
		const definition: DomainMachineDefinition<
			"awaiting-payment" | "awaiting-shipping",
			{ readonly paid: boolean },
			{ readonly type: "Ship" }
		> = {
			initial: "awaiting-payment",
			initialContext: () => ({ paid: false }),
			states: {
				"awaiting-payment": {
					on: {
						Ship: {
							target: "awaiting-shipping",
							guard: () => rejection,
							reduce: () => {
								reduceCalled = true;
								return undefined;
							},
						},
					},
				},
				"awaiting-shipping": { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(machine.can({ type: "Ship" })).toBe(false);
		let thrown: unknown;
		try {
			machine.dispatch({ type: "Ship" });
		} catch (cause) {
			thrown = cause;
		}
		expect(thrown).toBe(rejection);
		expect(machine.state).toBe("awaiting-payment");
		expect(reduceCalled).toBe(false);
	});

	it("throws structured errors for invalid guard results", () => {
		for (const invalidResult of [
			undefined,
			new Error("not a domain rejection"),
			Promise.resolve(true),
		]) {
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
								guard: (() => invalidResult) as unknown as () => boolean,
							},
						},
					},
					closed: { terminal: true },
				},
			};
			const snapshot = createInitialDomainMachineSnapshot(definition);
			const machine = new DomainStateMachine(definition);

			expect(() =>
				canTransitionDomainState(definition, snapshot, { type: "Close" }),
			).toThrow(InvalidDomainTransitionGuardResultError);
			expect(() => machine.dispatch({ type: "Close" })).toThrow(
				InvalidDomainTransitionGuardResultError,
			);
			expect(machine.state).toBe("open");
		}
	});

	it("throws invalid transition errors before validating unused input payloads", () => {
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
			} as unknown as CheckoutInput),
		).toThrow(InvalidDomainTransitionError);
		expect(() =>
			transitionDomainState(definition, completed, {
				type: "Cancel",
				reason: "too-late",
				callback: () => "not data",
			} as unknown as CheckoutInput),
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

	it("rejects runtime input names inherited from Object.prototype", () => {
		const machine = new DomainStateMachine(checkoutDefinition());

		for (const type of ["toString", "constructor", "__proto__"]) {
			const input = { type } as CheckoutInput;

			expect(machine.can(input)).toBe(false);
			expect(() => machine.dispatch(input)).toThrow(
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

	it("rejects unknown definition properties instead of ignoring guard typos", () => {
		const invalidDefinitions = [
			{
				initial: "open",
				initialContext: () => ({}),
				states: { open: {} },
				unknown: true,
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: { open: { unknown: true } },
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: {
					open: {
						on: {
							Close: {
								target: "closed",
								gaurd: () => false,
							},
						},
					},
					closed: { terminal: true },
				},
			},
		];

		for (const candidate of invalidDefinitions) {
			expect(
				() =>
					new DomainStateMachine(
						candidate as unknown as DomainMachineDefinition<
							"open" | "closed",
							Record<string, never>,
							{ readonly type: "Close" }
						>,
					),
			).toThrow(InvalidDomainMachineDefinitionError);
		}
	});

	it("rejects definition entries that cannot survive a stable copy", () => {
		const hiddenStates = {};
		Object.defineProperty(hiddenStates, "open", {
			value: {},
			enumerable: false,
		});
		const symbolTransition = Symbol("Close");
		const invalidDefinitions = [
			{
				initial: "open",
				initialContext: () => ({}),
				states: hiddenStates,
			},
			{
				initial: "open",
				initialContext: () => ({}),
				states: {
					open: {
						on: { [symbolTransition]: { target: "closed" } },
					},
					closed: { terminal: true },
				},
			},
		];

		for (const candidate of invalidDefinitions) {
			expect(
				() =>
					new DomainStateMachine(
						candidate as unknown as DomainMachineDefinition<
							"open" | "closed",
							Record<string, never>,
							{ readonly type: "Close" }
						>,
					),
			).toThrow(InvalidDomainMachineDefinitionError);
		}
	});

	it("rejects inherited definition behavior instead of ignoring it", () => {
		const transition = Object.create({ guard: () => false }) as {
			target: "closed";
		};
		transition.target = "closed";
		const definition = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: { on: { Close: transition } },
				closed: { terminal: true },
			},
		} as DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close" }
		>;

		expect(() => new DomainStateMachine(definition)).toThrow(
			InvalidDomainMachineDefinitionError,
		);
	});

	it("returns false or throws structured errors for malformed runtime inputs", () => {
		const machine = new DomainStateMachine(checkoutDefinition());
		const malformedInputs = [null, undefined, {}, { type: 123 }];

		for (const input of malformedInputs) {
			expect(machine.can(input as unknown as CheckoutInput)).toBe(false);
			expect(() => machine.dispatch(input as unknown as CheckoutInput)).toThrow(
				InvalidDomainMachineInputError,
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

	it("rejects async reducers without advancing the state", () => {
		const definition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly value: number },
			{ readonly type: "Close" },
			{ readonly type: "Closed" }
		> = {
			initial: "open",
			initialContext: () => ({ value: 0 }),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: (async () => ({
								context: { value: 1 },
								outputs: [{ type: "Closed" as const }],
							})) as unknown as () => {
								readonly context: { readonly value: number };
								readonly outputs: readonly [{ readonly type: "Closed" }];
							},
						},
					},
				},
				closed: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(() => machine.dispatch({ type: "Close" })).toThrow(
			InvalidDomainTransitionResultError,
		);
		expect(machine.state).toBe("open");
		expect(machine.context.value).toBe(0);
	});

	it("rejects unknown reducer result properties without advancing the state", () => {
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
							reduce: (() => ({
								output: [{ type: "Closed" }],
							})) as unknown as () => { readonly outputs: readonly [] },
						},
					},
				},
				closed: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(() => machine.dispatch({ type: "Close" })).toThrow(
			InvalidDomainTransitionResultError,
		);
		expect(machine.state).toBe("open");
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

	it("rejects invalid transition snapshots before mutating the wrapper", () => {
		type State = "open" | "closed";
		type Context = { readonly approved: boolean };
		type Input = { readonly type: "Close" };
		const definition: DomainMachineDefinition<State, Context, Input> = {
			initial: "open",
			initialContext: () => ({ approved: false }),
			validateSnapshot: ({ state, context }) =>
				state !== "closed" || context.approved,
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: () => ({ context: { approved: false } }),
						},
					},
				},
				closed: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(() => machine.dispatch({ type: "Close" })).toThrow(
			InvalidDomainMachineSnapshotError,
		);
		expect(machine.snapshot).toEqual({
			state: "open",
			context: { approved: false },
		});
	});

	it("rejects reentrant dispatch without changing the wrapper state", () => {
		type State = "open" | "outer" | "inner";
		type Input = { readonly type: "Outer" } | { readonly type: "Inner" };
		const definition: DomainMachineDefinition<
			State,
			Record<string, never>,
			Input
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Outer: {
							target: "outer",
							reduce: () => {
								machine.dispatch({ type: "Inner" });
								return undefined;
							},
						},
						Inner: { target: "inner" },
					},
				},
				outer: { terminal: true },
				inner: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);

		let thrown: unknown;
		try {
			machine.dispatch({ type: "Outer" });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toMatchObject({
			name: "ReentrantDomainStateMachineEvaluationError",
		});
		expect(machine.state).toBe("open");
	});

	it("rejects dispatch started by a can guard", () => {
		type State = "open" | "checked" | "closed";
		type Input = { readonly type: "Check" } | { readonly type: "Close" };
		const definition: DomainMachineDefinition<
			State,
			Record<string, never>,
			Input
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Check: {
							target: "checked",
							guard: () => {
								machine.dispatch({ type: "Close" });
								return true;
							},
						},
						Close: { target: "closed" },
					},
				},
				checked: { terminal: true },
				closed: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(() => machine.can({ type: "Check" })).toThrowError(
			expect.objectContaining({
				name: "ReentrantDomainStateMachineEvaluationError",
			}),
		);
		expect(machine.state).toBe("open");
	});

	it("releases the evaluation lock after a callback throws", () => {
		let shouldThrow = true;
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
							reduce: () => {
								if (shouldThrow) {
									shouldThrow = false;
									throw new Error("callback failed");
								}
								return undefined;
							},
						},
					},
				},
				closed: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(() => machine.dispatch({ type: "Close" })).toThrow(
			"callback failed",
		);
		expect(machine.state).toBe("open");
		expect(machine.dispatch({ type: "Close" }).to).toBe("closed");
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

	it("does not let dispatch results mutate its current snapshot", () => {
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
		type GuardedInput =
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
			GuardedInput
		> = {
			initial: "awaiting-payment",
			initialContext: () => initialContext,
			states: {
				"awaiting-payment": {
					on: {
						SetPayment: {
							target: "awaiting-payment",
							reduce: ({ context, input }) => {
								reducerContext = {
									payment: { id: input.paymentId },
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

	it("does not let pure transition guards mutate caller-owned input data", () => {
		type InputWithPayload = {
			readonly type: "Check";
			readonly payload: { readonly allowed: boolean };
		};
		const input: InputWithPayload = {
			type: "Check",
			payload: { allowed: false },
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			InputWithPayload
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Check: {
							target: "closed",
							guard: ({ input }) => {
								(input.payload as { allowed: boolean }).allowed = true;
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
				input,
			),
		).toThrow(TypeError);
		expect(input.payload.allowed).toBe(false);
	});

	it("does not let pure transition reducers mutate caller-owned input data", () => {
		type InputWithPayload = {
			readonly type: "Close";
			readonly payload: { readonly audit: readonly string[] };
		};
		const input: InputWithPayload = {
			type: "Close",
			payload: { audit: [] },
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			InputWithPayload
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: ({ input }) => {
								(input.payload.audit as string[]).push("mutated");
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
				input,
			),
		).toThrow(TypeError);
		expect(input.payload.audit).toEqual([]);
	});

	it("preserves and freezes complex context graphs across snapshots", () => {
		const symbolKey = Symbol("context");
		type SharedValue = { value: string };
		type CyclicValue = { name: string; self?: CyclicValue };
		type ComplexContext = {
			readonly [symbolKey]: { readonly code: string };
			readonly shared: SharedValue;
			readonly lookup: {
				readonly shared: SharedValue;
				readonly cycle: CyclicValue;
			};
			readonly selected: readonly SharedValue[];
			readonly cycle: CyclicValue;
		};
		const shared: SharedValue = { value: "initial" };
		const cycle: CyclicValue = { name: "root" };
		cycle.self = cycle;
		const originalContext: ComplexContext = {
			[symbolKey]: { code: "secret" },
			shared,
			lookup: { shared, cycle },
			selected: [shared],
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
								context.lookup.shared === context.shared &&
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

		expect(exposed.lookup.shared).toBe(exposed.shared);
		expect(exposed.selected[0]).toBe(exposed.shared);
		expect(exposed.cycle.self).toBe(exposed.cycle);
		expect(exposed[symbolKey].code).toBe("secret");
		expect(machine.can({ type: "Close" })).toBe(true);

		shared.value = "outside";
		expect(machine.context.shared.value).toBe("initial");
		expect(() => (exposed.selected as SharedValue[]).push(shared)).toThrow(
			TypeError,
		);
		expect(() => {
			(exposed[symbolKey] as { code: string }).code = "mutated";
		}).toThrow(TypeError);
	});

	it("accepts cross-realm plain data and normalizes it to local prototypes", () => {
		type ForeignContext = {
			readonly nested: { readonly value: string };
			readonly items: readonly number[];
		};
		const foreignContext = runInNewContext(
			`({ nested: { value: "foreign" }, items: [1, 2] })`,
		) as ForeignContext;
		const definition: DomainMachineDefinition<
			"open",
			ForeignContext,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => foreignContext,
			states: { open: {} },
		};

		const context = new DomainStateMachine(definition).context;

		expect(context).toEqual({
			nested: { value: "foreign" },
			items: [1, 2],
		});
		expect(Object.getPrototypeOf(context)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(context.nested)).toBe(Object.prototype);
		expect(Object.getPrototypeOf(context.items)).toBe(Array.prototype);
		expect(Object.isFrozen(context)).toBe(true);
		expect(Object.isFrozen(context.nested)).toBe(true);
		expect(Object.isFrozen(context.items)).toBe(true);
	});

	it("rejects custom prototypes disguised as intrinsic Object prototypes", () => {
		const createDisguisedRecord = (): Record<string, unknown> => {
			const fakeConstructor = function FakeObject() {};
			Object.defineProperty(fakeConstructor, "name", { value: "Object" });
			Object.setPrototypeOf(fakeConstructor.prototype, null);
			const value = Object.create(fakeConstructor.prototype) as Record<
				string,
				unknown
			>;
			value.value = "disguised";
			return value;
		};
		const contextDefinition: DomainMachineDefinition<
			"open",
			Record<string, unknown>,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: createDisguisedRecord,
			states: { open: {} },
		};
		const inputDefinition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close" }
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
							reduce: () => ({ outputs: [createDisguisedRecord()] }),
						},
					},
				},
				closed: { terminal: true },
			},
		};
		const input = createDisguisedRecord();
		input.type = "Close";

		expect(() => new DomainStateMachine(contextDefinition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(() =>
			transitionDomainState(
				inputDefinition,
				createInitialDomainMachineSnapshot(inputDefinition),
				input as { readonly type: "Close" },
			),
		).toThrow(InvalidDomainMachineInputError);
		expect(() =>
			transitionDomainState(
				outputDefinition,
				createInitialDomainMachineSnapshot(outputDefinition),
				{ type: "Close" },
			),
		).toThrow(InvalidDomainTransitionResultError);
	});

	it("rejects custom array prototypes disguised as intrinsic Array prototypes", () => {
		const fakeArrayPrototype: unknown[] = [];
		Object.setPrototypeOf(fakeArrayPrototype, Object.prototype);
		const fakeConstructor = function FakeArray() {};
		Object.defineProperty(fakeConstructor, "name", { value: "Array" });
		Object.defineProperty(fakeConstructor, "prototype", {
			value: fakeArrayPrototype,
		});
		Object.defineProperty(fakeArrayPrototype, "constructor", {
			value: fakeConstructor,
		});
		const disguisedArray = [1, 2];
		Object.setPrototypeOf(disguisedArray, fakeArrayPrototype);
		const definition: DomainMachineDefinition<
			"open",
			{ readonly items: readonly number[] },
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => ({ items: disguisedArray }),
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			InvalidDomainMachineContextError,
		);
	});

	it("rejects intrinsic constructor names disguised behind Proxies", () => {
		const fakeObjectConstructor = function FakeObject() {};
		Object.defineProperty(fakeObjectConstructor, "name", { value: "Object" });
		const disguisedObjectConstructor = new Proxy(fakeObjectConstructor, {});
		Object.defineProperty(fakeObjectConstructor.prototype, "constructor", {
			value: disguisedObjectConstructor,
		});
		Object.setPrototypeOf(fakeObjectConstructor.prototype, null);
		const disguisedObject = Object.create(
			fakeObjectConstructor.prototype,
		) as Record<string, unknown>;
		disguisedObject.value = "disguised";

		const fakeArrayPrototype: unknown[] = [];
		Object.setPrototypeOf(fakeArrayPrototype, Object.prototype);
		const fakeArrayConstructor = function FakeArray() {};
		Object.defineProperty(fakeArrayConstructor, "name", { value: "Array" });
		const disguisedArrayConstructor = new Proxy(fakeArrayConstructor, {});
		Object.defineProperty(fakeArrayConstructor, "prototype", {
			value: fakeArrayPrototype,
		});
		Object.defineProperty(fakeArrayPrototype, "constructor", {
			value: disguisedArrayConstructor,
		});
		const disguisedArray = [1, 2];
		Object.setPrototypeOf(disguisedArray, fakeArrayPrototype);

		for (const context of [disguisedObject, { items: disguisedArray }]) {
			const definition: DomainMachineDefinition<
				"open",
				Record<string, unknown>,
				{ readonly type: "Stay" }
			> = {
				initial: "open",
				initialContext: () => context,
				states: { open: {} },
			};

			expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
				InvalidDomainMachineContextError,
			);
		}
	});

	it("rejects inherited cross-realm toStringTag accessors without invoking them", () => {
		const tracker = { calls: 0 };
		const foreignContext = runInNewContext(
			`Object.defineProperty(Object.prototype, Symbol.toStringTag, {
				configurable: true,
				get() {
					tracker.calls += 1;
					return "Object";
				},
			});
			({ value: "foreign" });`,
			{ tracker },
		) as { readonly value: string };
		const definition: DomainMachineDefinition<
			"open",
			typeof foreignContext,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => foreignContext,
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(tracker.calls).toBe(0);
	});

	it("rejects inherited cross-realm array toStringTag accessors without invoking them", () => {
		const tracker = { calls: 0 };
		const foreignItems = runInNewContext(
			`Object.defineProperty(Array.prototype, Symbol.toStringTag, {
				configurable: true,
				get() {
					tracker.calls += 1;
					return "Array";
				},
			});
			[1, 2];`,
			{ tracker },
		) as readonly number[];
		const definition: DomainMachineDefinition<
			"open",
			{ readonly items: readonly number[] },
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => ({ items: foreignItems }),
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(tracker.calls).toBe(0);
	});

	it("accepts cross-realm inputs and reducer results", () => {
		type Input = {
			readonly type: "Close";
			readonly payload: { readonly value: number };
		};
		type Context = { readonly value: number };
		type Output = { readonly type: "Closed" };
		const foreignInput = runInNewContext(
			`({ type: "Close", payload: { value: 1 } })`,
		) as Input;
		const foreignResult = runInNewContext(
			`({ context: { value: 1 }, outputs: [{ type: "Closed" }] })`,
		) as {
			readonly context: Context;
			readonly outputs: readonly Output[];
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Context,
			Input,
			Output
		> = {
			initial: "open",
			initialContext: () => ({ value: 0 }),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							guard: ({ input }) => input.payload.value === 1,
							reduce: () => foreignResult,
						},
					},
				},
				closed: { terminal: true },
			},
		};

		const result = transitionDomainState(
			definition,
			createInitialDomainMachineSnapshot(definition),
			foreignInput,
		);

		expect(result.snapshot.context).toEqual({ value: 1 });
		expect(result.outputs).toEqual([{ type: "Closed" }]);
		expect(Object.getPrototypeOf(result.snapshot.context)).toBe(
			Object.prototype,
		);
		expect(Object.getPrototypeOf(result.outputs)).toBe(Array.prototype);
	});

	it("rejects context values that cannot be made deeply immutable", () => {
		const mapWithSpoofedFreezeGuard = new Map<string, boolean>();
		Object.defineProperty(mapWithSpoofedFreezeGuard, "set", {
			value: () => mapWithSpoofedFreezeGuard,
			enumerable: false,
			writable: false,
			configurable: false,
		});
		const invalidContexts = [
			{ callback: () => "not data" },
			{ date: new Date("2024-01-01T00:00:00.000Z") },
			{ pattern: /payment/g },
			{ lookup: new Map([["payment", true]]) },
			{ lookup: mapWithSpoofedFreezeGuard },
			{ selected: new Set(["payment"]) },
			{ bytes: new Uint8Array([1, 2, 3]) },
			{ buffer: new ArrayBuffer(8) },
			{ deferred: Promise.resolve("later") },
			{ weak: new WeakMap<object, string>() },
			{ weak: new WeakSet<object>() },
			{ error: new Error("not domain data") },
			{ boxed: new Number(1) },
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

	it("rejects context data deeper than the traversal limit", () => {
		const definition: DomainMachineDefinition<
			"open",
			Record<string, unknown>,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => nestedRecord(257),
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			/maximum depth of 256/,
		);
	});

	it("accepts context data at exactly the maximum traversal depth", () => {
		const definition: DomainMachineDefinition<
			"open",
			Record<string, unknown>,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => nestedRecord(256),
			states: { open: {} },
		};

		const snapshot = createInitialDomainMachineSnapshot(definition);

		expect(Object.isFrozen(snapshot.context)).toBe(true);
	});

	it("enforces the depth limit before resolving shared references", () => {
		const shared = { value: "shared" };
		const chain: Record<string, unknown> = {};
		let current = chain;
		for (let depth = 1; depth < 256; depth++) {
			const next: Record<string, unknown> = {};
			current.next = next;
			current = next;
		}
		current.next = shared;
		const context = { shared, chain };
		const definition: DomainMachineDefinition<
			"open",
			typeof context,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => context,
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			/maximum depth of 256/,
		);
	});

	it("rejects context data with too many unique object nodes", () => {
		const definition: DomainMachineDefinition<
			"open",
			{ readonly nodes: readonly Record<string, never>[] },
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => ({
				nodes: Array.from({ length: 10_000 }, () => ({})),
			}),
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			/more than 10,000 object nodes/,
		);
	});

	it("accepts context data with exactly the maximum unique object nodes", () => {
		const context = Array.from({ length: 9_999 }, () => ({}));
		const definition: DomainMachineDefinition<
			"open",
			typeof context,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => context,
			states: { open: {} },
		};

		const snapshot = createInitialDomainMachineSnapshot(definition);

		expect(snapshot.context).toHaveLength(9_999);
		expect(Object.isFrozen(snapshot.context)).toBe(true);
	});

	it("rejects context data with too many own properties", () => {
		const context: Record<string, number> = {};
		for (let index = 0; index < 100_001; index++) {
			context[`property-${index}`] = index;
		}
		const definition: DomainMachineDefinition<
			"open",
			Record<string, number>,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => context,
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			/more than 100,000 own properties/,
		);
	});

	it("accepts context data with exactly the maximum own properties", () => {
		const context: Record<string, number> = {};
		for (let index = 0; index < 100_000; index++) {
			context[`property-${index}`] = index;
		}
		const definition: DomainMachineDefinition<
			"open",
			Record<string, number>,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => context,
			states: { open: {} },
		};

		const snapshot = createInitialDomainMachineSnapshot(definition);

		expect(snapshot.context["property-99999"]).toBe(99_999);
		expect(Object.isFrozen(snapshot.context)).toBe(true);
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

	it("rejects context toStringTag accessors without invoking them", () => {
		let accessorInvoked = false;
		const context = {};
		Object.defineProperty(context, Symbol.toStringTag, {
			get: () => {
				accessorInvoked = true;
				return "Object";
			},
		});
		const definition: DomainMachineDefinition<
			"open",
			typeof context,
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => context,
			states: { open: {} },
		};

		expect(() => createInitialDomainMachineSnapshot(definition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(accessorInvoked).toBe(false);
	});

	it("rejects input toStringTag accessors without invoking them", () => {
		let accessorInvoked = false;
		const input = { type: "Close" as const };
		Object.defineProperty(input, Symbol.toStringTag, {
			get: () => {
				accessorInvoked = true;
				return "Object";
			},
		});
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			typeof input
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
				input,
			),
		).toThrow(InvalidDomainMachineInputError);
		expect(accessorInvoked).toBe(false);
	});

	it("rejects output toStringTag accessors without invoking them", () => {
		let accessorInvoked = false;
		const output = { type: "Closed" as const };
		Object.defineProperty(output, Symbol.toStringTag, {
			get: () => {
				accessorInvoked = true;
				return "Object";
			},
		});
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
		expect(accessorInvoked).toBe(false);
	});

	it("rejects array accessor properties without invoking them", () => {
		const contextArray: unknown[] = [];
		const inputArray: unknown[] = [];
		const outputArray: unknown[] = [];
		let contextArrayAccessorInvoked = false;
		let inputArrayAccessorInvoked = false;
		let outputArrayAccessorInvoked = false;

		Object.defineProperty(contextArray, "0", {
			enumerable: true,
			get: () => {
				contextArrayAccessorInvoked = true;
				throw new Error("context array getter must not run");
			},
		});
		Object.defineProperty(inputArray, "0", {
			enumerable: true,
			get: () => {
				inputArrayAccessorInvoked = true;
				throw new Error("input array getter must not run");
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
		const inputDefinition: DomainMachineDefinition<
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
				inputDefinition,
				createInitialDomainMachineSnapshot(inputDefinition),
				{ type: "Close", items: inputArray },
			),
		).toThrow(InvalidDomainMachineInputError);
		expect(() =>
			transitionDomainState(
				outputDefinition,
				createInitialDomainMachineSnapshot(outputDefinition),
				{ type: "Close" },
			),
		).toThrow(InvalidDomainTransitionResultError);

		expect(contextArrayAccessorInvoked).toBe(false);
		expect(inputArrayAccessorInvoked).toBe(false);
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
		class SecretDate extends Date {}
		class SecretRegExp extends RegExp {
			constructor() {
				super("secret");
			}
		}
		const dateWithAlteredPrototype = new Date();
		Object.setPrototypeOf(dateWithAlteredPrototype, {});

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
		const inputDefinition: DomainMachineDefinition<
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
		const dateDefinition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly secret: SecretDate },
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ secret: new SecretDate() }),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const regexpInputDefinition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close"; readonly secret: SecretRegExp }
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const alteredPrototypeDefinition: DomainMachineDefinition<
			"open" | "closed",
			{ readonly secret: Date },
			{ readonly type: "Close" }
		> = {
			initial: "open",
			initialContext: () => ({ secret: dateWithAlteredPrototype }),
			states: {
				open: { on: { Close: { target: "closed" } } },
				closed: { terminal: true },
			},
		};
		const setInputDefinition: DomainMachineDefinition<
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
		expect(() => new DomainStateMachine(dateDefinition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(() => new DomainStateMachine(alteredPrototypeDefinition)).toThrow(
			InvalidDomainMachineContextError,
		);
		expect(() =>
			transitionDomainState(
				inputDefinition,
				createInitialDomainMachineSnapshot(inputDefinition),
				{ type: "Close", secret: new SecretValue("input") },
			),
		).toThrow(InvalidDomainMachineInputError);
		expect(() =>
			transitionDomainState(
				setInputDefinition,
				createInitialDomainMachineSnapshot(setInputDefinition),
				{ type: "Close", secret: new SecretSet() },
			),
		).toThrow(InvalidDomainMachineInputError);
		expect(() =>
			transitionDomainState(
				regexpInputDefinition,
				createInitialDomainMachineSnapshot(regexpInputDefinition),
				{ type: "Close", secret: new SecretRegExp() },
			),
		).toThrow(InvalidDomainMachineInputError);
		expect(() =>
			transitionDomainState(
				outputDefinition,
				createInitialDomainMachineSnapshot(outputDefinition),
				{ type: "Close" },
			),
		).toThrow(InvalidDomainTransitionResultError);
	});

	it("rejects Array subclasses instead of silently removing their behavior", () => {
		class SecretArray extends Array<string> {
			secret(): string {
				return "behavior";
			}
		}
		const definition: DomainMachineDefinition<
			"open",
			{ readonly values: readonly string[] },
			{ readonly type: "Stay" }
		> = {
			initial: "open",
			initialContext: () => ({ values: new SecretArray("value") }),
			states: { open: {} },
		};

		expect(() => new DomainStateMachine(definition)).toThrow(
			InvalidDomainMachineContextError,
		);
	});

	it("rejects custom properties on built-in data without invoking accessors", () => {
		const dateWithProperty = new Date("2024-01-01T00:00:00.000Z");
		Object.defineProperty(dateWithProperty, "custom", {
			enumerable: true,
			value: "lost metadata",
		});
		const setWithProperty = new Set(["value"]);
		Object.defineProperty(setWithProperty, "custom", {
			enumerable: true,
			value: "lost metadata",
		});
		const regexpWithAccessor = /close/;
		let regexpAccessorInvoked = false;
		Object.defineProperty(regexpWithAccessor, "custom", {
			enumerable: true,
			get: () => {
				regexpAccessorInvoked = true;
				throw new Error("regexp accessor must not run");
			},
		});
		const mapWithAccessor = new Map([["key", "value"]]);
		let mapAccessorInvoked = false;
		Object.defineProperty(mapWithAccessor, "custom", {
			enumerable: true,
			get: () => {
				mapAccessorInvoked = true;
				throw new Error("map accessor must not run");
			},
		});

		for (const value of [dateWithProperty, setWithProperty]) {
			const definition: DomainMachineDefinition<
				"open" | "closed",
				{ readonly value: unknown },
				{ readonly type: "Close" }
			> = {
				initial: "open",
				initialContext: () => ({ value }),
				states: {
					open: { on: { Close: { target: "closed" } } },
					closed: { terminal: true },
				},
			};

			expect(() => new DomainStateMachine(definition)).toThrow(
				InvalidDomainMachineContextError,
			);
		}

		const inputDefinition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close"; readonly value: unknown }
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
							reduce: () => ({ outputs: [mapWithAccessor] }),
						},
					},
				},
				closed: { terminal: true },
			},
		};

		expect(() =>
			transitionDomainState(
				inputDefinition,
				createInitialDomainMachineSnapshot(inputDefinition),
				{ type: "Close", value: regexpWithAccessor },
			),
		).toThrow(InvalidDomainMachineInputError);
		expect(() =>
			transitionDomainState(
				outputDefinition,
				createInitialDomainMachineSnapshot(outputDefinition),
				{ type: "Close" },
			),
		).toThrow(InvalidDomainTransitionResultError);
		expect(regexpAccessorInvoked).toBe(false);
		expect(mapAccessorInvoked).toBe(false);
	});

	it("rejects input values that cannot be made deeply immutable", () => {
		const invalidInputs = [
			{ type: "Close", callback: () => "not data" },
			{ type: "Close", date: new Date("2024-01-01T00:00:00.000Z") },
			{ type: "Close", pattern: /close/ },
			{ type: "Close", lookup: new Map([["close", true]]) },
			{ type: "Close", selected: new Set(["close"]) },
			{ type: "Close", bytes: new Uint8Array([1, 2, 3]) },
			{ type: "Close", deferred: Promise.resolve("later") },
			{ type: "Close", weak: new WeakMap<object, string>() },
		];

		for (const input of invalidInputs) {
			const definition: DomainMachineDefinition<
				"open" | "closed",
				Record<string, never>,
				typeof input
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
					input,
				),
			).toThrow(InvalidDomainMachineInputError);
		}
	});

	it("rejects input data deeper than the traversal limit", () => {
		type DeepInput = {
			readonly type: "Close";
			readonly payload: Record<string, unknown>;
		};
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			DeepInput
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
				{ type: "Close", payload: nestedRecord(256) },
			),
		).toThrow(/maximum depth of 256/);
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

	it("evaluates pure transitions against a stable definition copy", () => {
		type State = "open" | "closed";
		type Input = { readonly type: "Close" };
		type Context = Record<string, never>;
		const closeTransition: DomainTransition<State, Context, Input, never> = {
			target: "closed",
			guard: () => {
				(closeTransition as { target: State | "missing" }).target = "missing";
				return true;
			},
		};
		const definition: DomainMachineDefinition<State, Context, Input> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: { on: { Close: closeTransition } },
				closed: { terminal: true },
			},
		};
		const snapshot = createInitialDomainMachineSnapshot(definition);

		const result = transitionDomainState(definition, snapshot, {
			type: "Close",
		});

		expect(result.to).toBe("closed");
		expect(result.snapshot.state).toBe("closed");
	});

	it("preserves non-enumerable guards in stable definition copies", () => {
		type State = "open" | "closed";
		type Input = { readonly type: "Close" };
		const transition = { target: "closed" } as {
			target: State;
			guard?: () => boolean;
		};
		Object.defineProperty(transition, "guard", {
			value: () => false,
			enumerable: false,
		});
		const definition: DomainMachineDefinition<
			State,
			Record<string, never>,
			Input
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: { on: { Close: transition } },
				closed: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);

		expect(machine.can({ type: "Close" })).toBe(false);
		expect(() => machine.dispatch({ type: "Close" })).toThrow(
			DomainTransitionGuardRejectedError,
		);
		expect(machine.state).toBe("open");
	});

	it("preserves non-enumerable targets and reducers in stable definition copies", () => {
		type State = "open" | "closed";
		type Context = { readonly value: number };
		type Input = { readonly type: "Close" };
		type Output = { readonly type: "Closed" };
		const transition = {} as {
			target: State;
			reduce: () => {
				readonly context: Context;
				readonly outputs: readonly Output[];
			};
		};
		Object.defineProperty(transition, "target", {
			value: "closed",
			enumerable: false,
		});
		Object.defineProperty(transition, "reduce", {
			value: () => ({
				context: { value: 1 },
				outputs: [{ type: "Closed" }],
			}),
			enumerable: false,
		});
		const definition: DomainMachineDefinition<State, Context, Input, Output> = {
			initial: "open",
			initialContext: () => ({ value: 0 }),
			states: {
				open: { on: { Close: transition } },
				closed: { terminal: true },
			},
		};

		const result = transitionDomainState(
			definition,
			createInitialDomainMachineSnapshot(definition),
			{ type: "Close" },
		);

		expect(result.to).toBe("closed");
		expect(result.snapshot.context.value).toBe(1);
		expect(result.outputs).toEqual([{ type: "Closed" }]);
	});

	it("copies and freezes transition output arrays", () => {
		const outputs: CheckoutOutput[] = [
			{ type: "RequestShipping", orderId: "order-1" },
		];
		const definition: DomainMachineDefinition<
			CheckoutState,
			CheckoutContext,
			CheckoutInput,
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
			{ date: new Date("2024-01-01T00:00:00.000Z") },
			{ pattern: /closed/ },
			{ lookup: new Map([["closed", true]]) },
			{ selected: new Set(["closed"]) },
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

	it("rejects transition output data deeper than the traversal limit", () => {
		const definition: DomainMachineDefinition<
			"open" | "closed",
			Record<string, never>,
			{ readonly type: "Close" },
			Record<string, unknown>
		> = {
			initial: "open",
			initialContext: () => ({}),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							reduce: () => ({ outputs: [nestedRecord(256)] }),
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
		).toThrow(/maximum depth of 256/);
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
		const badInput = new InvalidDomainMachineInputError("bad");
		const badGuard = new InvalidDomainTransitionGuardResultError("bad");
		const badResult = new InvalidDomainTransitionResultError("bad");
		const reentrant = new ReentrantDomainStateMachineEvaluationError();

		expect(invalid).toBeInstanceOf(DomainError);
		expect(rejected).toBeInstanceOf(DomainError);
		expect(invalid.inputType).toBe("Cancel");
		expect(rejected.inputType).toBe("PaymentReceived");
		expect(badDefinition).not.toBeInstanceOf(DomainError);
		expect(badContext).not.toBeInstanceOf(DomainError);
		expect(badSnapshot).not.toBeInstanceOf(DomainError);
		expect(badInput).not.toBeInstanceOf(DomainError);
		expect(badGuard).not.toBeInstanceOf(DomainError);
		expect(badResult).not.toBeInstanceOf(DomainError);
		expect(reentrant).not.toBeInstanceOf(DomainError);
		expect(isBaseError(invalid)).toBe(true);
		expect(isBaseError(rejected)).toBe(true);
		expect(isBaseError(badDefinition)).toBe(true);
		expect(isBaseError(badContext)).toBe(true);
		expect(isBaseError(badSnapshot)).toBe(true);
		expect(isBaseError(badInput)).toBe(true);
		expect(isBaseError(badGuard)).toBe(true);
		expect(isBaseError(badResult)).toBe(true);
		expect(isBaseError(reentrant)).toBe(true);
	});

	it("types transition callbacks to the input selected by the on-key", () => {
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
							reduce: ({ state, context, input }) => {
								const sourceState: "open" = state;
								return {
									context: {
										seen: [...context.seen, `${sourceState}:${input.name}`],
									},
								};
							},
						},
						Numbered: {
							target: "closed",
							guard: ({ state, input }) => {
								const sourceState: "open" = state;
								return sourceState === "open" && input.value > 0;
							},
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
			// @ts-expect-error Input union members must carry a string type.
			{ readonly type: 123 },
			never
		>;
		void (null as unknown as InvalidDefinition);

		const assertConstructorAcceptsUndefinedSnapshot = () => {
			// An explicit undefined snapshot typechecks against the overload and
			// falls back to the initial snapshot, so a nullable stored snapshot
			// can be passed straight through without a narrowing branch.
			new DomainStateMachine(definition, undefined);
		};
		void assertConstructorAcceptsUndefinedSnapshot;
	});

	it("exposes deeply immutable machine data as deeply readonly types", () => {
		type MutableContext = { nested: { value: string } };
		type MutableInput = { type: "Close"; payload: { value: string } };
		type MutableOutput = { type: "Closed"; payload: { value: string } };
		const definition: DomainMachineDefinition<
			"open" | "closed",
			MutableContext,
			MutableInput,
			MutableOutput
		> = {
			initial: "open",
			initialContext: () => ({ nested: { value: "initial" } }),
			states: {
				open: {
					on: {
						Close: {
							target: "closed",
							guard: ({ context, input }) => {
								const assertCallbackDataIsReadonly = () => {
									// @ts-expect-error Callback context is deeply readonly.
									context.nested.value = "mutated";
									// @ts-expect-error Callback inputs are deeply readonly.
									input.payload.value = "mutated";
								};
								void assertCallbackDataIsReadonly;
								return true;
							},
							reduce: ({ input }) => ({
								context: { nested: { value: input.payload.value } },
								outputs: [
									{ type: "Closed", payload: { value: input.payload.value } },
								],
							}),
						},
					},
				},
				closed: { terminal: true },
			},
		};
		const machine = new DomainStateMachine(definition);
		const result = machine.dispatch({
			type: "Close",
			payload: { value: "closed" },
		});

		const assertReturnedDataIsReadonly = () => {
			// @ts-expect-error Machine context is deeply readonly.
			machine.context.nested.value = "mutated";
			// @ts-expect-error Snapshot context is deeply readonly.
			result.snapshot.context.nested.value = "mutated";
			const output = result.outputs[0];
			if (output !== undefined) {
				// @ts-expect-error Transition outputs are deeply readonly.
				output.payload.value = "mutated";
			}
		};
		void assertReturnedDataIsReadonly;

		expect(result.snapshot.context.nested.value).toBe("closed");
		expect(result.outputs[0]?.payload.value).toBe("closed");
	});
});
