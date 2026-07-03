import { BaseError } from "@shirudo/base-error";
import { DomainError } from "../core/errors";

export class InvalidDomainTransitionError extends DomainError<"InvalidDomainTransitionError"> {
	constructor(
		public readonly state: string,
		public readonly eventType: string,
	) {
		super(`No domain transition from "${state}" on "${eventType}".`);
	}
}

export class DomainTransitionGuardRejectedError extends DomainError<"DomainTransitionGuardRejectedError"> {
	constructor(
		public readonly state: string,
		public readonly eventType: string,
	) {
		super(`Domain transition guard rejected "${eventType}" from "${state}".`);
	}
}

export class InvalidDomainMachineDefinitionError extends BaseError<"InvalidDomainMachineDefinitionError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineDefinitionError" });
	}
}

export class InvalidDomainMachineContextError extends BaseError<"InvalidDomainMachineContextError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineContextError" });
	}
}

export class InvalidDomainMachineSnapshotError extends BaseError<"InvalidDomainMachineSnapshotError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineSnapshotError" });
	}
}

export class InvalidDomainMachineEventError extends BaseError<"InvalidDomainMachineEventError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainMachineEventError" });
	}
}

export class InvalidDomainTransitionGuardResultError extends BaseError<"InvalidDomainTransitionGuardResultError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainTransitionGuardResultError" });
	}
}

export class InvalidDomainTransitionResultError extends BaseError<"InvalidDomainTransitionResultError"> {
	constructor(message: string, cause?: unknown) {
		super(message, cause, { name: "InvalidDomainTransitionResultError" });
	}
}

export class ReentrantDomainStateMachineEvaluationError extends BaseError<"ReentrantDomainStateMachineEvaluationError"> {
	constructor() {
		super(
			"Domain state machine callbacks cannot evaluate the same machine.",
			undefined,
			{ name: "ReentrantDomainStateMachineEvaluationError" },
		);
	}
}
