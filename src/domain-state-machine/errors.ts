import { BaseError } from "@shirudo/base-error";
import { DomainError } from "../core/errors";

/** No transition is defined for the input in the current state. */
export class InvalidDomainTransitionError extends DomainError<"InvalidDomainTransitionError"> {
	constructor(
		public readonly state: string,
		public readonly inputType: string,
	) {
		super(`No domain transition from "${state}" on "${inputType}".`);
	}
}

/** A defined transition was rejected by its domain guard. */
export class DomainTransitionGuardRejectedError extends DomainError<"DomainTransitionGuardRejectedError"> {
	constructor(
		public readonly state: string,
		public readonly inputType: string,
	) {
		super(`Domain transition guard rejected "${inputType}" from "${state}".`);
	}
}

/** The machine definition violates its runtime contract. */
export class InvalidDomainMachineDefinitionError extends BaseError<"InvalidDomainMachineDefinitionError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineDefinitionError" });
	}
}

/** Context contains unsupported or unsafe runtime data. */
export class InvalidDomainMachineContextError extends BaseError<"InvalidDomainMachineContextError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineContextError" });
	}
}

/** A supplied or produced snapshot is malformed or violates invariants. */
export class InvalidDomainMachineSnapshotError extends BaseError<"InvalidDomainMachineSnapshotError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineSnapshotError" });
	}
}

/** An input is malformed or contains unsupported runtime data. */
export class InvalidDomainMachineInputError extends BaseError<"InvalidDomainMachineInputError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineInputError" });
	}
}

/** A guard returned a value other than `boolean` or `DomainError`. */
export class InvalidDomainTransitionGuardResultError extends BaseError<"InvalidDomainTransitionGuardResultError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainTransitionGuardResultError" });
	}
}

/** A reducer returned a malformed result or unsupported output data. */
export class InvalidDomainTransitionResultError extends BaseError<"InvalidDomainTransitionResultError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainTransitionResultError" });
	}
}

/** A callback attempted to evaluate the same stateful machine recursively. */
export class ReentrantDomainStateMachineEvaluationError extends BaseError<"ReentrantDomainStateMachineEvaluationError"> {
	constructor() {
		super(
			"Domain state machine callbacks cannot evaluate the same machine.",
			undefined,
			{ name: "ReentrantDomainStateMachineEvaluationError" },
		);
	}
}
