import {
	assertNotFromAnotherKitCopy,
	markKitCopy,
} from "../../internal/kit-copy";
import type { StandardSchemaV1 } from "../../internal/standard-schema";
import { copyPlainData } from "../../internal/structural/plain-data";
import type { DomainEvent } from "./domain-event";
import {
	assertEventSchemaVersion,
	assertNonBlankEventField,
	type DomainEventPayloadIssue,
	DomainEventValidationError,
} from "./domain-event-errors";

/**
 * A domain event type paired with the Standard Schema of its payload and the
 * schema version of that payload. Build it with {@link defineDomainEvent}.
 *
 * An event created from a definition takes the schema output as its payload:
 * the schema decides what the payload may contain. As for every event, the
 * kit copies the output under its plain-data rule (records, arrays, `Date`,
 * `Map`, `Set`, and primitives) and freezes the copy. A schema that passes a value through unchecked, for
 * example `z.any()`, moves the responsibility for that value to the schema.
 * A schema that leaves out unknown keys, such as `z.object`, drops fields
 * without an error, so use strict object schemas for event payloads.
 */
export interface DomainEventDefinition<
	TType extends string = string,
	TSchema extends StandardSchemaV1 = StandardSchemaV1,
> {
	readonly type: TType;
	readonly schemaVersion: number;
	readonly payload: TSchema;
}

/** The stamped event of a definition: its type and its schema output. */
export type DomainEventOf<TDefinition extends DomainEventDefinition> =
	DomainEvent<
		TDefinition["type"],
		StandardSchemaV1.InferOutput<TDefinition["payload"]>
	>;

/**
 * The payload that a call takes to create an event of a definition: the
 * input of its schema.
 * @inline
 */
export type DomainEventPayloadInput<TDefinition extends DomainEventDefinition> =
	StandardSchemaV1.InferInput<TDefinition["payload"]>;

const DEFINITIONS = new WeakSet<object>();

/**
 * Defines a domain event type with a Standard Schema for its payload, for
 * example a zod, valibot, or arktype schema. Pass the definition in place of
 * the type to `createEvent`, `createDomainEvent`, `DomainEventFactory.create`,
 * or `createStampedDomainEvent`. The schema must validate synchronously.
 *
 * @example
 * ```ts
 * const OrderPlaced = defineDomainEvent("OrderPlaced", {
 *   payload: z.strictObject({ orderId: z.string(), total: z.number().int() }),
 *   schemaVersion: 2,
 * });
 * type OrderPlaced = DomainEventOf<typeof OrderPlaced>;
 *
 * // In an aggregate method:
 * this.setState(next, this.createEvent(OrderPlaced, { orderId, total }));
 * ```
 */
export function defineDomainEvent<
	TType extends string,
	TSchema extends StandardSchemaV1,
>(
	type: TType,
	options: { readonly payload: TSchema; readonly schemaVersion?: number },
): DomainEventDefinition<TType, TSchema> {
	assertNonBlankEventField(type, "type", "EVENT_TYPE_INVALID");
	const schemaVersion = options.schemaVersion ?? 1;
	assertEventSchemaVersion(schemaVersion);
	if (!isStandardSchema(options.payload)) {
		throw new TypeError(
			`defineDomainEvent: the payload of "${type}" must be a Standard Schema version 1 (an object with "~standard".validate), for example a zod, valibot, or arktype schema`,
		);
	}
	const definition: DomainEventDefinition<TType, TSchema> = {
		type,
		schemaVersion,
		payload: options.payload,
	};
	markKitCopy(definition);
	Object.freeze(definition);
	DEFINITIONS.add(definition);
	return definition;
}

/**
 * Whether `value` came out of {@link defineDomainEvent} of this kit copy.
 * Throws `DUPLICATE_KIT_COPY` for a definition of another loaded copy.
 */
export function isDomainEventDefinition(
	value: unknown,
): value is DomainEventDefinition {
	if (typeof value !== "object" || value === null) return false;
	if (DEFINITIONS.has(value)) return true;
	assertNotFromAnotherKitCopy(value, "The event definition");
	return false;
}

function isStandardSchema(value: unknown): value is StandardSchemaV1 {
	if (typeof value !== "object" && typeof value !== "function") return false;
	if (value === null) return false;
	const props = (value as { readonly "~standard"?: unknown })["~standard"];
	return (
		typeof props === "object" &&
		props !== null &&
		(props as { readonly version?: unknown }).version === 1 &&
		typeof (props as { readonly validate?: unknown }).validate === "function"
	);
}

/**
 * The payload of an event of `definition`: the schema output, checked for
 * plain data and copied, so that freezing the event never reaches the
 * caller's objects. The caller freezes the copy with the event.
 */
export function ownDefinedPayload(
	definition: DomainEventDefinition,
	payload: unknown,
	operation: string,
): unknown {
	const result = definition.payload["~standard"].validate(payload);
	if (isThenable(result)) {
		throw new DomainEventValidationError(
			"EVENT_PAYLOAD_SCHEMA_ASYNC",
			"payload",
			`${operation}: the payload schema of "${definition.type}" returned a Promise. An event is created synchronously, so use a synchronous schema. A zod schema also returns a Promise when one of its refinements throws.`,
		);
	}
	if (result.issues) {
		const issues = ownIssues(result.issues);
		throw new DomainEventValidationError(
			"EVENT_PAYLOAD_INVALID",
			"payload",
			`${operation}: the payload of "${definition.type}" does not match its schema: ${describeIssues(issues)}`,
			issues,
		);
	}
	// The copy checks the output too: z.date(), z.any(), and z.custom() pass
	// the caller's objects through, and arktype returns the input itself.
	return copyPlainData(result.value, { subject: `${operation}: payload` });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	return (
		(typeof value === "object" || typeof value === "function") &&
		value !== null &&
		typeof (value as { readonly then?: unknown }).then === "function"
	);
}

function ownIssues(
	issues: ReadonlyArray<StandardSchemaV1.Issue>,
): ReadonlyArray<DomainEventPayloadIssue> {
	return Object.freeze(
		issues.map((issue) =>
			Object.freeze({
				message: String(issue.message),
				path: Object.freeze(
					(issue.path ?? []).map((segment) =>
						typeof segment === "object" && segment !== null
							? segment.key
							: segment,
					),
				),
			}),
		),
	);
}

const DESCRIBED_ISSUES = 3;

function describeIssues(
	issues: ReadonlyArray<DomainEventPayloadIssue>,
): string {
	if (issues.length === 0) return "the schema reported no issue text";
	const described = issues
		.slice(0, DESCRIBED_ISSUES)
		.map((issue) =>
			issue.path.length === 0
				? issue.message
				: `${issue.path.map(String).join(".")}: ${issue.message}`,
		);
	const more = issues.length - described.length;
	return more > 0
		? `${described.join("; ")}; and ${more} more`
		: described.join("; ");
}
