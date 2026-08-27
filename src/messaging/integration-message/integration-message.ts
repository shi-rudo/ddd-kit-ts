import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import {
	type AnyDomainEvent,
	createDomainEvent,
	type DomainEvent,
	type EventMetadata,
} from "../../domain/event/domain-event";
import { deepFreeze } from "../../domain/value-object/value-object";
import { InvalidIntegrationMessageError } from "../../errors/kit-errors";
import {
	assertJsonValue,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "../../internal/json-value";
import type { CommitPosition, CommittedDomainEvent } from "../committed-event";

export type {
	JsonObject,
	JsonPrimitive,
	JsonValue,
} from "../../internal/json-value";

/** Standard relationship headers carried by the public message envelope. */
export interface IntegrationMessageRelationships {
	/** Groups messages that belong to one operation or trace. */
	readonly correlationId?: string;
	/** Groups a long-running business interaction across several correlations. */
	readonly conversationId?: string;
	/** Identifies the message, event, or command that immediately caused this one. */
	readonly causationId?: string;
}

/** Application-owned public content produced from one internal domain event. */
export interface IntegrationMessageContent<
	TType extends string,
	TPayload extends JsonValue,
	TMetadata extends JsonObject = JsonObject,
> extends IntegrationMessageRelationships {
	readonly type: TType;
	readonly version: number;
	readonly payload: TPayload;
	/** Custom JSON metadata; relationship header names are reserved. */
	readonly metadata?: TMetadata;
}

/**
 * JSON-safe broker envelope, deliberately separate from {@link DomainEvent}.
 * Standard message relationships are explicit headers rather than payload or
 * custom metadata. Its source cursor supports ordered, gap-aware projection
 * consumption.
 */
export interface IntegrationMessage<
	TType extends string = string,
	TPayload extends JsonValue = JsonValue,
	TMetadata extends JsonObject = JsonObject,
> extends IntegrationMessageContent<TType, TPayload, TMetadata> {
	readonly messageId: string;
	readonly occurredAt: string;
	readonly source: AggregateAddress;
	readonly position: CommitPosition;
}

/** Maps a private domain event to its explicit public message schema. */
export type IntegrationMessageMapper<
	Evt extends AnyDomainEvent,
	TType extends string,
	TPayload extends JsonValue,
	TMetadata extends JsonObject = JsonObject,
> = (event: Evt) => IntegrationMessageContent<TType, TPayload, TMetadata>;

/**
 * Maps a committed domain event to a deeply frozen JSON-safe message. The
 * mapper explicitly chooses every public relationship header; producer-private
 * domain metadata is never copied implicitly. Values JSON would change or
 * discard reject as {@link InvalidIntegrationMessageError}.
 */
export function createIntegrationMessage<
	Evt extends AnyDomainEvent,
	TType extends string,
	TPayload extends JsonValue,
	TMetadata extends JsonObject = JsonObject,
>(
	record: CommittedDomainEvent<Evt>,
	mapper: IntegrationMessageMapper<Evt, TType, TPayload, TMetadata>,
): IntegrationMessage<TType, TPayload, TMetadata> {
	const content = mapper(record.event);
	return stabilizeIntegrationMessage({
		messageId: record.event.eventId,
		type: content.type,
		version: content.version,
		occurredAt: record.event.occurredAt.toISOString(),
		...relationshipHeaders(content),
		payload: content.payload,
		...(content.metadata === undefined ? {} : { metadata: content.metadata }),
		source: record.source,
		position: record.position,
	});
}

/** Validates and serializes an integration message without lossy coercion. */
export function encodeIntegrationMessage(message: IntegrationMessage): string {
	assertIntegrationMessage(message);
	return JSON.stringify(message);
}

/**
 * Parses and validates a broker body, normalizes supported RFC 3339 timestamps
 * to canonical UTC milliseconds, then defensively copies and deeply freezes it.
 */
export function decodeIntegrationMessage(
	serialized: string,
): IntegrationMessage {
	try {
		return stabilizeIntegrationMessage(JSON.parse(serialized), "wire");
	} catch (error) {
		if (error instanceof InvalidIntegrationMessageError) throw error;
		throw new InvalidIntegrationMessageError(
			"$",
			"body is not valid JSON",
			error,
		);
	}
}

/**
 * Composes a validated public message into a minted local projector input.
 * Relationship headers become local event metadata. The public JSON schema is
 * retained; producer-private domain types are not reconstructed.
 */
export function integrationMessageToCommittedEvent<
	TType extends string,
	TPayload extends JsonValue,
	TMetadata extends JsonObject = JsonObject,
>(
	message: IntegrationMessage<TType, TPayload, TMetadata>,
): CommittedDomainEvent<DomainEvent<TType, TPayload>> {
	const stableMessage = stabilizeIntegrationMessage(message);
	const metadata = localEventMetadata(stableMessage);
	return {
		event: createDomainEvent(stableMessage.type, stableMessage.payload, {
			eventId: stableMessage.messageId,
			aggregateId: stableMessage.source.aggregateId,
			aggregateType: stableMessage.source.aggregateType,
			occurredAt: new Date(stableMessage.occurredAt),
			schemaVersion: stableMessage.version,
			metadata,
		}),
		source: stableMessage.source,
		position: stableMessage.position,
	};
}

function stabilizeIntegrationMessage<T>(
	value: T,
	timestampFormat: "canonical" | "wire" = "canonical",
): T {
	assertIntegrationMessage(value, timestampFormat);
	const copy = JSON.parse(JSON.stringify(value));
	if (timestampFormat === "wire") {
		copy.occurredAt = normalizeWireTimestamp(copy.occurredAt);
	}
	return deepFreeze(copy) as T;
}

function assertIntegrationMessage(
	value: unknown,
	timestampFormat: "canonical" | "wire" = "canonical",
): asserts value is IntegrationMessage {
	assertJsonValue(value, "$", invalid);
	if (!isJsonObject(value)) {
		invalid("$", "envelope must be a plain JSON object");
	}
	if (typeof value.messageId !== "string" || value.messageId.length === 0) {
		invalid("$.messageId", "must be a non-empty string");
	}
	for (const field of RELATIONSHIP_FIELDS) {
		if (!Object.hasOwn(value, field)) continue;
		const relationshipId = value[field];
		if (typeof relationshipId !== "string" || relationshipId.length === 0) {
			invalid(`$.${field}`, "must be a non-empty string when present");
		}
	}
	if (typeof value.type !== "string" || value.type.length === 0) {
		invalid("$.type", "must be a non-empty string");
	}
	const version = value.version;
	if (
		typeof version !== "number" ||
		!Number.isInteger(version) ||
		version < 1
	) {
		invalid("$.version", "must be an integer >= 1");
	}
	if (
		typeof value.occurredAt !== "string" ||
		(timestampFormat === "canonical"
			? !isCanonicalIsoTimestamp(value.occurredAt)
			: normalizeWireTimestamp(value.occurredAt) === undefined)
	) {
		invalid(
			"$.occurredAt",
			timestampFormat === "canonical"
				? "must be a canonical UTC ISO-8601 timestamp"
				: "must be an RFC 3339 timestamp with an explicit offset and at most millisecond precision",
		);
	}
	if (!Object.hasOwn(value, "payload")) {
		invalid("$.payload", "is required (use null for an empty JSON payload)");
	}
	if (
		Object.hasOwn(value, "metadata") &&
		value.metadata !== undefined &&
		!isJsonObject(value.metadata)
	) {
		invalid("$.metadata", "must be a plain JSON object when present");
	}
	if (isJsonObject(value.metadata)) {
		for (const field of RELATIONSHIP_FIELDS) {
			if (Object.hasOwn(value.metadata, field)) {
				invalid(
					`$.metadata.${field}`,
					"is reserved for the explicit message envelope header",
				);
			}
		}
	}
	if (!isJsonObject(value.source)) {
		invalid("$.source", "must be a plain JSON object");
	}
	if (
		typeof value.source.aggregateType !== "string" ||
		value.source.aggregateType.length === 0
	) {
		invalid("$.source.aggregateType", "must be a non-empty string");
	}
	if (
		typeof value.source.aggregateId !== "string" ||
		value.source.aggregateId.length === 0
	) {
		invalid("$.source.aggregateId", "must be a non-empty string");
	}
	if (!isJsonObject(value.position)) {
		invalid("$.position", "must be a plain JSON object");
	}
	const { position } = value;
	const aggregateVersion = position.aggregateVersion;
	if (
		typeof aggregateVersion !== "number" ||
		!Number.isInteger(aggregateVersion) ||
		aggregateVersion < 0
	) {
		invalid("$.position.aggregateVersion", "must be an integer >= 0");
	}
	const commitSequence = position.commitSequence;
	if (
		typeof commitSequence !== "number" ||
		!Number.isInteger(commitSequence) ||
		commitSequence < 0
	) {
		invalid("$.position.commitSequence", "must be an integer >= 0");
	}
	const commitSize = position.commitSize;
	if (
		typeof commitSize !== "number" ||
		!Number.isInteger(commitSize) ||
		commitSize <= commitSequence
	) {
		invalid(
			"$.position.commitSize",
			"must be a positive integer greater than commitSequence",
		);
	}
	if (!Object.hasOwn(position, "previousEventfulAggregateVersion")) {
		invalid(
			"$.position.previousEventfulAggregateVersion",
			"is required (use null at genesis)",
		);
	}
	const previous = position.previousEventfulAggregateVersion;
	if (
		previous !== null &&
		(typeof previous !== "number" ||
			!Number.isInteger(previous) ||
			previous < 0 ||
			previous >= aggregateVersion)
	) {
		invalid(
			"$.position.previousEventfulAggregateVersion",
			"must be null at genesis or an earlier non-negative aggregate version",
		);
	}
}

const RELATIONSHIP_FIELDS = [
	"correlationId",
	"conversationId",
	"causationId",
] as const;

function relationshipHeaders(
	primary: IntegrationMessageRelationships,
): IntegrationMessageRelationships {
	const { correlationId, conversationId, causationId } = primary;
	return {
		...(correlationId === undefined ? {} : { correlationId }),
		...(conversationId === undefined ? {} : { conversationId }),
		...(causationId === undefined ? {} : { causationId }),
	};
}

function localEventMetadata(
	message: IntegrationMessage,
): EventMetadata | undefined {
	const relationships = relationshipHeaders(message);
	if (
		message.metadata === undefined &&
		Object.keys(relationships).length === 0
	) {
		return undefined;
	}
	return { ...message.metadata, ...relationships };
}

function isCanonicalIsoTimestamp(value: string): boolean {
	const timestamp = new Date(value);
	return (
		!Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value
	);
}

const WIRE_TIMESTAMP =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](\d{2}):(\d{2}))$/;

function normalizeWireTimestamp(value: string): string | undefined {
	const match = WIRE_TIMESTAMP.exec(value);
	if (match === null) return undefined;

	const [
		,
		year,
		month,
		day,
		hour,
		minute,
		second,
		,
		,
		offsetHour,
		offsetMinute,
	] = match;
	const numericYear = Number(year);
	const numericMonth = Number(month);
	const numericDay = Number(day);
	if (
		numericMonth < 1 ||
		numericMonth > 12 ||
		numericDay < 1 ||
		numericDay > daysInMonth(numericYear, numericMonth) ||
		Number(hour) > 23 ||
		Number(minute) > 59 ||
		Number(second) > 59 ||
		(offsetHour !== undefined && Number(offsetHour) > 23) ||
		(offsetMinute !== undefined && Number(offsetMinute) > 59)
	) {
		return undefined;
	}

	const timestamp = new Date(value);
	return Number.isNaN(timestamp.getTime())
		? undefined
		: timestamp.toISOString();
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) {
		return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
	}
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function invalid(path: string, reason: string): never {
	throw new InvalidIntegrationMessageError(path, reason);
}
