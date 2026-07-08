import { DomainError, KitWiringError } from "../core/errors";

/** No transition is defined for the input in the current state. */
export class InvalidDomainTransitionError extends DomainError<"INVALID_DOMAIN_TRANSITION"> {
	constructor(
		public readonly state: string,
		public readonly inputType: string,
	) {
		super({
			code: "INVALID_DOMAIN_TRANSITION",
			message: `No domain transition from "${state}" on "${inputType}".`,
		});
	}
}

/** A defined transition was rejected by its domain guard. */
export class DomainTransitionGuardRejectedError extends DomainError<"DOMAIN_TRANSITION_GUARD_REJECTED"> {
	constructor(
		public readonly state: string,
		public readonly inputType: string,
	) {
		super({
			code: "DOMAIN_TRANSITION_GUARD_REJECTED",
			message: `Domain transition guard rejected "${inputType}" from "${state}".`,
		});
	}
}

/** The machine definition violates its runtime contract. */
export class InvalidDomainMachineDefinitionError extends KitWiringError<"INVALID_DOMAIN_MACHINE_DEFINITION"> {
	constructor(message: string, cause?: unknown) {
		super("INVALID_DOMAIN_MACHINE_DEFINITION", message, cause);
	}
}

/** Context contains unsupported or unsafe runtime data. */
export class InvalidDomainMachineContextError extends KitWiringError<"INVALID_DOMAIN_MACHINE_CONTEXT"> {
	constructor(message: string, cause?: unknown) {
		super("INVALID_DOMAIN_MACHINE_CONTEXT", message, cause);
	}
}

/** A supplied or produced snapshot is malformed or violates invariants. */
export class InvalidDomainMachineSnapshotError extends KitWiringError<"INVALID_DOMAIN_MACHINE_SNAPSHOT"> {
	constructor(message: string, cause?: unknown) {
		super("INVALID_DOMAIN_MACHINE_SNAPSHOT", message, cause);
	}
}

/** An input is malformed or contains unsupported runtime data. */
export class InvalidDomainMachineInputError extends KitWiringError<"INVALID_DOMAIN_MACHINE_INPUT"> {
	constructor(message: string, cause?: unknown) {
		super("INVALID_DOMAIN_MACHINE_INPUT", message, cause);
	}
}

/** A guard returned a value other than `boolean` or `DomainError`. */
export class InvalidDomainTransitionGuardResultError extends KitWiringError<"INVALID_DOMAIN_TRANSITION_GUARD_RESULT"> {
	constructor(message: string, cause?: unknown) {
		super("INVALID_DOMAIN_TRANSITION_GUARD_RESULT", message, cause);
	}
}

/** A reducer returned a malformed result or unsupported output data. */
export class InvalidDomainTransitionResultError extends KitWiringError<"INVALID_DOMAIN_TRANSITION_RESULT"> {
	constructor(message: string, cause?: unknown) {
		super("INVALID_DOMAIN_TRANSITION_RESULT", message, cause);
	}
}

/** A callback attempted to evaluate the same stateful machine recursively. */
export class ReentrantDomainStateMachineEvaluationError extends KitWiringError<"REENTRANT_DOMAIN_STATE_MACHINE_EVALUATION"> {
	constructor() {
		super(
			"REENTRANT_DOMAIN_STATE_MACHINE_EVALUATION",
			"Domain state machine callbacks cannot evaluate the same machine.",
		);
	}
}
