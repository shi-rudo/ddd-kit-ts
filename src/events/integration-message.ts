import type { AggregateAddress } from "../aggregate/aggregate-address";
import {
	type AnyDomainEvent,
	createDomainEvent,
	type DomainEvent,
} from "../aggregate/domain-event";
import { InvalidIntegrationMessageError } from "../core/errors";
import { deepFreeze } from "../value-object/value-object";
import type { CommitPosition, CommittedDomainEvent } from "./ports";

/** A primitive value represented without loss by JSON. */
export type JsonPrimitive = boolean | null | number | string;
/** A recursively JSON-safe value. Runtime codecs additionally reject lossy shapes. */
export type JsonValue =
	| JsonPrimitive
	| ReadonlyArray<JsonValue>
	| { readonly [key: string]: JsonValue };
/** A JSON-safe object used for optional integration metadata. */
export type JsonObject = { readonly [key: string]: JsonValue };

/** Application-owned public content produced from one internal domain event. */
export interface IntegrationMessageContent<
	TType extends string,
	TPayload extends JsonValue,
	TMetadata extends JsonObject = JsonObject,
> {
	readonly type: TType;
	readonly version: number;
	readonly payload: TPayload;
	readonly metadata?: TMetadata;
}

/**
 * JSON-safe broker envelope, deliberately separate from {@link DomainEvent}.
 * Its source cursor supports ordered, gap-aware projection consumption.
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
 * Maps a committed domain event to a deeply frozen JSON-safe message.
 * Values JSON would change or discard reject as
 * {@link InvalidIntegrationMessageError}.
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
 * The public JSON schema is retained; producer-private domain types are not
 * reconstructed.
 */
export function integrationMessageToCommittedEvent<
	TType extends string,
	TPayload extends JsonValue,
	TMetadata extends JsonObject = JsonObject,
>(
	message: IntegrationMessage<TType, TPayload, TMetadata>,
): CommittedDomainEvent<DomainEvent<TType, TPayload>> {
	const stableMessage = stabilizeIntegrationMessage(message);
	return {
		event: createDomainEvent(stableMessage.type, stableMessage.payload, {
			eventId: stableMessage.messageId,
			aggregateId: stableMessage.source.aggregateId,
			aggregateType: stableMessage.source.aggregateType,
			occurredAt: new Date(stableMessage.occurredAt),
			version: stableMessage.version,
			metadata: stableMessage.metadata,
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
	assertJsonValue(value, "$");
	if (!isJsonObject(value)) {
		invalid("$", "envelope must be a plain JSON object");
	}
	if (typeof value.messageId !== "string" || value.messageId.length === 0) {
		invalid("$.messageId", "must be a non-empty string");
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

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

function assertJsonValue(
	value: unknown,
	path: string,
	active = new WeakSet<object>(),
): asserts value is JsonValue {
	if (value === null) return;
	switch (typeof value) {
		case "string":
		case "boolean":
			return;
		case "number":
			if (Number.isFinite(value)) return;
			throw new InvalidIntegrationMessageError(
				path,
				"numbers must be finite JSON numbers",
			);
		case "object":
			break;
		default:
			throw new InvalidIntegrationMessageError(
				path,
				`value of type ${typeof value} is not JSON-safe`,
			);
	}

	if (active.has(value)) {
		throw new InvalidIntegrationMessageError(
			path,
			"cyclic references are not JSON-safe",
		);
	}
	active.add(value);
	if (Array.isArray(value)) {
		for (const key of Reflect.ownKeys(value)) {
			if (key === "length") continue;
			if (typeof key === "symbol") {
				throw new InvalidIntegrationMessageError(
					path,
					"symbol-keyed array properties would be dropped by JSON",
				);
			}
			const index = Number(key);
			if (
				!Number.isInteger(index) ||
				index < 0 ||
				index >= value.length ||
				String(index) !== key
			) {
				throw new InvalidIntegrationMessageError(
					`${path}.${key}`,
					"named array properties would be dropped by JSON",
				);
			}
		}
		for (let index = 0; index < value.length; index += 1) {
			const descriptor = Object.getOwnPropertyDescriptor(value, index);
			if (descriptor === undefined) {
				throw new InvalidIntegrationMessageError(
					`${path}[${index}]`,
					"sparse array holes would change to null in JSON",
				);
			}
			if (!("value" in descriptor) || !descriptor.enumerable) {
				throw new InvalidIntegrationMessageError(
					`${path}[${index}]`,
					"accessor and non-enumerable array elements are not JSON-safe",
				);
			}
			assertJsonValue(descriptor.value, `${path}[${index}]`, active);
		}
		active.delete(value);
		return;
	}

	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new InvalidIntegrationMessageError(
			path,
			"Date, Map, Set, and class instances are not JSON-safe here; map " +
				"them explicitly to strings, arrays, or plain objects",
		);
	}
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === "symbol") {
			throw new InvalidIntegrationMessageError(
				path,
				"symbol-keyed properties would be dropped by JSON",
			);
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor === undefined) continue;
		const childPath = `${path}.${key}`;
		if (key === "__proto__") {
			throw new InvalidIntegrationMessageError(
				childPath,
				"hostile __proto__ keys are not accepted at integration boundaries",
			);
		}
		if (!("value" in descriptor) || !descriptor.enumerable) {
			throw new InvalidIntegrationMessageError(
				childPath,
				"accessor and non-enumerable properties are not JSON-safe",
			);
		}
		assertJsonValue(descriptor.value, childPath, active);
	}
	active.delete(value);
}
