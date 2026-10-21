export type DomainEventValidationCode =
	| "EVENT_ID_REQUIRED"
	| "EVENT_ID_INVALID"
	| "EVENT_TYPE_INVALID"
	| "EVENT_OCCURRED_AT_REQUIRED"
	| "EVENT_OCCURRED_AT_INVALID"
	| "EVENT_SCHEMA_VERSION_INVALID"
	| "EVENT_AGGREGATE_IDENTITY_INVALID"
	| "EVENT_PAYLOAD_INVALID"
	| "EVENT_PAYLOAD_SCHEMA_ASYNC";

export type DomainEventValidationField =
	| "eventId"
	| "type"
	| "occurredAt"
	| "schemaVersion"
	| "aggregateId"
	| "aggregateType"
	| "payload";

/** One finding of a payload schema, with its path as plain keys. */
export interface DomainEventPayloadIssue {
	readonly message: string;
	readonly path: ReadonlyArray<PropertyKey>;
}

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
		/** The findings of the payload schema, for `EVENT_PAYLOAD_INVALID`. */
		readonly issues?: ReadonlyArray<DomainEventPayloadIssue>,
	) {
		super(message);
		this.name = code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export function assertNonBlankEventField(
	value: unknown,
	field: "eventId" | "type" | "aggregateId" | "aggregateType",
	code:
		| "EVENT_ID_INVALID"
		| "EVENT_TYPE_INVALID"
		| "EVENT_AGGREGATE_IDENTITY_INVALID",
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new DomainEventValidationError(
			code,
			field,
			`domain-event ${field} must be a non-blank string`,
		);
	}
}

export function assertEventSchemaVersion(schemaVersion: unknown): void {
	if (
		typeof schemaVersion !== "number" ||
		!Number.isSafeInteger(schemaVersion) ||
		schemaVersion < 1
	) {
		throw new DomainEventValidationError(
			"EVENT_SCHEMA_VERSION_INVALID",
			"schemaVersion",
			"domain-event schemaVersion must be a safe integer greater than or equal to 1",
		);
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
