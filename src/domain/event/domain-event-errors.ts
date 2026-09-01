export type DomainEventValidationCode =
	| "EVENT_ID_REQUIRED"
	| "EVENT_ID_INVALID"
	| "EVENT_TYPE_INVALID"
	| "EVENT_OCCURRED_AT_REQUIRED"
	| "EVENT_OCCURRED_AT_INVALID"
	| "EVENT_SCHEMA_VERSION_INVALID"
	| "EVENT_ADDRESS_INVALID";

export type DomainEventValidationField =
	| "eventId"
	| "type"
	| "occurredAt"
	| "schemaVersion"
	| "aggregateId"
	| "aggregateType";

/**
 * Stable contract error for malformed domain-event data.
 *
 * It remains a `TypeError` for JavaScript callers while exposing a code and
 * field that do not depend on the wording of the human-readable message.
 */
export class DomainEventValidationError extends TypeError {
	// The kit's error identity model applies here too: name === code, so
	// there is no second identifier to keep in sync.
	override readonly name: string;

	constructor(
		readonly code: DomainEventValidationCode,
		readonly field: DomainEventValidationField,
		message: string,
	) {
		super(message);
		this.name = code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export class SnapshotTimeValidationError extends TypeError {
	override readonly name = "SNAPSHOT_TIME_INVALID";
	readonly code = "SNAPSHOT_TIME_INVALID" as const;
	readonly field = "snapshotAt" as const;

	constructor() {
		super("snapshotAt must be a valid Date");
		Object.setPrototypeOf(this, new.target.prototype);
	}
}
