import { assertNoOwnProtoKey } from "../../errors/kit-errors";
import {
	applyCooperativeBrand,
	hasCooperativeBrand,
} from "../../internal/cooperative-brand";
import type { StandardSchemaV1 } from "../../internal/standard-schema";
import { isIntrinsicConstructorPrototype } from "../../internal/structural/is-built-in";
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
 * the schema decides what the payload may contain, in place of the deep check
 * that an event without a definition gets. The kit still requires plain data
 * (records, arrays, `Date`, `Map`, `Set`, and primitives), copies the output,
 * and freezes the copy. A schema that passes a value through unchecked, for
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

// One copy of the kit recognizes its own definitions through the WeakSet,
// and another copy in the same process through the cooperative brand.
const DEFINITIONS = new WeakSet<object>();
const DEFINITION_BRAND = Symbol.for(
	"@shirudo/ddd-kit/domain-event-definition/v1",
);

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
	applyCooperativeBrand(definition, DEFINITION_BRAND);
	Object.freeze(definition);
	DEFINITIONS.add(definition);
	return definition;
}

/** Whether `value` came out of {@link defineDomainEvent}. */
export function isDomainEventDefinition(
	value: unknown,
): value is DomainEventDefinition {
	return (
		typeof value === "object" &&
		value !== null &&
		(DEFINITIONS.has(value) || hasCooperativeBrand(value, DEFINITION_BRAND))
	);
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
	const value = result.value;
	if (value !== null && typeof value === "object") {
		assertNoOwnProtoKey(value, `Event payload of ${operation}`);
	}
	assertPlainSchemaOutput(
		value,
		"",
		`${operation}: the payload schema of "${definition.type}" returned`,
		new Set(),
	);
	return structuredClone(value);
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

/**
 * Checks that schema output is plain data before the copy: `structuredClone`
 * would turn a class instance into a plain record without an error, and a
 * freeze cannot make a binary buffer or a `RegExp` immutable. The check reads
 * the prototype of each object once, so it costs a small part of the deep
 * check that an event without a definition gets.
 */
function assertPlainSchemaOutput(
	value: unknown,
	path: string,
	subject: string,
	seen: Set<object>,
): void {
	if (typeof value === "function" || typeof value === "symbol") {
		throw new TypeError(
			`${subject} a ${typeof value} at payload${path}; an event payload holds plain data`,
		);
	}
	if (value === null || typeof value !== "object") return;
	if (seen.has(value)) return;
	seen.add(value);
	const kind = plainDataKind(value);
	switch (kind) {
		case "record": {
			for (const key of Object.keys(value)) {
				assertPlainSchemaOutput(
					(value as Record<string, unknown>)[key],
					`${path}.${key}`,
					subject,
					seen,
				);
			}
			if (
				Object.getOwnPropertySymbols(value).some((symbol) =>
					Object.prototype.propertyIsEnumerable.call(value, symbol),
				)
			) {
				throw new TypeError(
					`${subject} a symbol-keyed property at payload${path}; the copy of the payload would lose it`,
				);
			}
			return;
		}
		case "array":
			(value as ReadonlyArray<unknown>).forEach((element, index) => {
				assertPlainSchemaOutput(element, `${path}[${index}]`, subject, seen);
			});
			return;
		case "map":
			for (const [key, entry] of value as ReadonlyMap<unknown, unknown>) {
				assertPlainSchemaOutput(key, `${path}.<map key>`, subject, seen);
				assertPlainSchemaOutput(
					entry,
					`${path}.get(${String(key)})`,
					subject,
					seen,
				);
			}
			return;
		case "set":
			for (const element of value as ReadonlySet<unknown>) {
				assertPlainSchemaOutput(element, `${path}.<set value>`, subject, seen);
			}
			return;
		case "date":
			return;
		default:
			throw new TypeError(
				`${subject} ${describeObject(value)} at payload${path}; an event payload holds plain data: records, arrays, Date, Map, Set, and primitives`,
			);
	}
}

type PlainDataKind = "record" | "array" | "date" | "map" | "set";

const PLAIN_DATA_PROTOTYPES: ReadonlyMap<object, PlainDataKind> = new Map<
	object,
	PlainDataKind
>([
	[Object.prototype, "record"],
	[Array.prototype, "array"],
	[Date.prototype, "date"],
	[Map.prototype, "map"],
	[Set.prototype, "set"],
]);

const INTRINSIC_NAMES: ReadonlyArray<[string, PlainDataKind]> = [
	["Object", "record"],
	["Array", "array"],
	["Date", "date"],
	["Map", "map"],
	["Set", "set"],
];

/**
 * The plain-data kind of an object, or `undefined`. The prototypes of this
 * realm answer directly; the slower intrinsic check covers an object from
 * another realm.
 */
function plainDataKind(value: object): PlainDataKind | undefined {
	const prototype = Object.getPrototypeOf(value);
	if (prototype === null) return "record";
	const kind = PLAIN_DATA_PROTOTYPES.get(prototype);
	if (kind !== undefined) return kind;
	for (const [name, intrinsicKind] of INTRINSIC_NAMES) {
		if (isIntrinsicConstructorPrototype(prototype, name)) return intrinsicKind;
	}
	return undefined;
}

function describeObject(value: object): string {
	const tag = Object.prototype.toString.call(value).slice(8, -1);
	const constructorName = (
		Object.getPrototypeOf(value) as {
			readonly constructor?: { name?: unknown };
		}
	)?.constructor?.name;
	return typeof constructorName === "string" && constructorName !== tag
		? `a class instance (${constructorName})`
		: `a ${tag}`;
}
