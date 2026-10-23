import { DomainError, KitWiringError } from "../../errors/kit-errors";

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
export function invalidDomainMachineDefinitionError(
	message: string,
	cause?: unknown,
): KitWiringError<"INVALID_DOMAIN_MACHINE_DEFINITION"> {
	return new KitWiringError({
		code: "INVALID_DOMAIN_MACHINE_DEFINITION",
		message,
		cause,
	});
}

/** Context contains unsupported or unsafe runtime data. */
export function invalidDomainMachineContextError(
	message: string,
	cause?: unknown,
): KitWiringError<"INVALID_DOMAIN_MACHINE_CONTEXT"> {
	return new KitWiringError({
		code: "INVALID_DOMAIN_MACHINE_CONTEXT",
		message,
		cause,
	});
}

/** A supplied or produced snapshot is malformed or violates invariants. */
export function invalidDomainMachineSnapshotError(
	message: string,
	cause?: unknown,
): KitWiringError<"INVALID_DOMAIN_MACHINE_SNAPSHOT"> {
	return new KitWiringError({
		code: "INVALID_DOMAIN_MACHINE_SNAPSHOT",
		message,
		cause,
	});
}

/** An input is malformed or contains unsupported runtime data. */
export function invalidDomainMachineInputError(
	message: string,
	cause?: unknown,
): KitWiringError<"INVALID_DOMAIN_MACHINE_INPUT"> {
	return new KitWiringError({
		code: "INVALID_DOMAIN_MACHINE_INPUT",
		message,
		cause,
	});
}

/** A guard returned a value other than `boolean` or `DomainError`. */
export function invalidDomainTransitionGuardResultError(
	message: string,
	cause?: unknown,
): KitWiringError<"INVALID_DOMAIN_TRANSITION_GUARD_RESULT"> {
	return new KitWiringError({
		code: "INVALID_DOMAIN_TRANSITION_GUARD_RESULT",
		message,
		cause,
	});
}

/** A reducer returned a malformed result or unsupported output data. */
export function invalidDomainTransitionResultError(
	message: string,
	cause?: unknown,
): KitWiringError<"INVALID_DOMAIN_TRANSITION_RESULT"> {
	return new KitWiringError({
		code: "INVALID_DOMAIN_TRANSITION_RESULT",
		message,
		cause,
	});
}

/** A callback attempted to evaluate the same stateful machine recursively. */
export function reentrantDomainStateMachineEvaluationError(): KitWiringError<"REENTRANT_DOMAIN_STATE_MACHINE_EVALUATION"> {
	return new KitWiringError({
		code: "REENTRANT_DOMAIN_STATE_MACHINE_EVALUATION",
		message: "Domain state machine callbacks cannot evaluate the same machine.",
	});
}
