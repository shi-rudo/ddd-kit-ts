import { InvalidCommandMessageError } from "../../../core/errors";
import type { AggregateAddress } from "../../../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../../../domain/event/domain-event";
import { deepFreeze } from "../../../domain/value-object/value-object";
import {
	assertJsonValue,
	isJsonObject,
	type JsonObject,
} from "../../../messaging/integration-message/json-value";
import type {
	EventCommitCandidate,
	EventCommitCandidatePosition,
	OutboxWriter,
} from "../../../messaging/ports";
import type { PublishedCommand } from "./command";

/**
 * Business relationships and technical trace context selected explicitly for
 * an outgoing command. Correlation/conversation explain the business flow;
 * W3C Trace Context connects technical spans.
 */
export interface CommandMessageRelationships {
	/** Groups messages that belong to one operation or trace. */
	readonly correlationId?: string;
	/** Groups every message in one long-running business interaction. */
	readonly conversationId?: string;
	/** W3C Trace Context parent for technical distributed tracing. */
	readonly traceparent?: string;
	/** Optional vendor trace state associated with `traceparent`. */
	readonly tracestate?: string;
}

/**
 * Application-owned Published Language produced from one private domain or
 * process event. `destination` names one receiver contract; it is deliberately
 * required because a command is an instruction, not a broadcast fact.
 *
 * The command carries a stable schema `version` and JSON-safe `payload`.
 * Domain value objects are translated to wire DTOs by the mapper before this
 * boundary.
 */
export interface CommandMessageContent<C extends PublishedCommand>
	extends CommandMessageRelationships {
	readonly destination: string;
	readonly command: C;
}

/**
 * Immutable, JSON-safe command envelope stored for later at-least-once
 * delivery.
 *
 * `causationId` always identifies the private event whose accepted decision
 * requested this command. The mapper cannot replace it with a weaker
 * correlation. Consumer-produced events should in turn use `messageId` as
 * their causation id.
 */
export interface DurableCommandMessage<C extends PublishedCommand>
	extends CommandMessageContent<C> {
	readonly messageId: string;
	readonly recordedAt: string;
	readonly causationId: string;
}

/**
 * Receipt for the private event that requested one command batch. It retains
 * commit identity and ordering without putting the private event or its
 * payload into the command outbox.
 */
export interface CommandCommitOriginCandidate {
	readonly eventId: string;
	readonly source: AggregateAddress;
	readonly position: EventCommitCandidatePosition;
}

/**
 * One private process-event commit and the exact commands it requested.
 * `messages` may be empty: the receipt still advances the originating source
 * and makes an exact retry distinguishable from a missing commit.
 */
export interface CommandOutboxCommitCandidate<C extends PublishedCommand> {
	readonly origin: CommandCommitOriginCandidate;
	readonly messages: ReadonlyArray<DurableCommandMessage<C>>;
}

/**
 * Write port for a dedicated transactional command outbox.
 *
 * The adapter is bound to the same ambient transaction as the aggregate or
 * event-stream repository. It must persist the complete input atomically,
 * retain input order, deduplicate exact retries by `origin.eventId`, and reject
 * a reused origin id whose source, position, or messages differ. It also owns
 * the durable source cursor represented by `origin.position`; an empty command
 * batch still advances that cursor.
 *
 * Delivery is out of band and at least once. A consumer therefore uses
 * `message.messageId` as its idempotency key and acknowledges only after the
 * command result has been stored.
 */
export interface CommandOutboxWriter<C extends PublishedCommand> {
	add(commits: ReadonlyArray<CommandOutboxCommitCandidate<C>>): Promise<void>;
}

/** Maps one private accepted event to zero or more addressed commands. */
export type CommandOutboxMapper<
	Evt extends AnyDomainEvent,
	C extends PublishedCommand,
> = (event: Evt) => ReadonlyArray<CommandMessageContent<C>>;

/**
 * Adapts a dedicated command outbox to the event-candidate write port consumed
 * by `withCommit`.
 *
 * Mapping happens inside the transaction, before the command outbox write.
 * The private event is used only at this boundary and is reduced to an origin
 * receipt. The helper never publishes it or copies its payload implicitly; the
 * application mapper selects and translates the data that belongs in the
 * versioned Published Language. The route rejects values JSON would lose or
 * change before it calls the adapter.
 * Every command gets a stable id derived from the event id and its zero-based
 * order, so an exact transaction retry produces the same rows.
 *
 * Omit `withCommit`'s in-process `bus` for private process events. Participants
 * consume the durable command messages from their explicitly named
 * destinations, while event-stream replay only rebuilds process state.
 */
export function routeEventsToCommandOutbox<
	C extends PublishedCommand,
	Evt extends AnyDomainEvent = AnyDomainEvent,
>(
	outbox: CommandOutboxWriter<C>,
	mapper: CommandOutboxMapper<Evt, C>,
): OutboxWriter<Evt> {
	return {
		add: async (events) => {
			const commits = events.map((candidate) =>
				toCommandCommit(candidate, mapper),
			);
			await outbox.add(commits);
		},
	};
}

function toCommandCommit<
	Evt extends AnyDomainEvent,
	C extends PublishedCommand,
>(
	candidate: EventCommitCandidate<Evt>,
	mapper: CommandOutboxMapper<Evt, C>,
): CommandOutboxCommitCandidate<C> {
	const mapped = mapper(candidate.event);
	if (!Array.isArray(mapped)) {
		throw new TypeError(
			"Command outbox mapper must return a readonly array of commands",
		);
	}
	const messages = Array.from(mapped, (content, index) =>
		toDurableCommand<C>(candidate.event, content, index),
	);
	return deepFreeze({
		origin: {
			eventId: candidate.event.eventId,
			source: { ...candidate.source },
			position: { ...candidate.position },
		},
		messages,
	}) as CommandOutboxCommitCandidate<C>;
}

function toDurableCommand<C extends PublishedCommand>(
	event: AnyDomainEvent,
	content: CommandMessageContent<C>,
	index: number,
): DurableCommandMessage<C> {
	if (
		content === null ||
		typeof content !== "object" ||
		Array.isArray(content)
	) {
		throw new TypeError("Command outbox mapper entry must be an object");
	}
	const {
		destination,
		command: sourceCommand,
		correlationId,
		conversationId,
		traceparent,
		tracestate,
	} = content;
	assertNonBlank("destination", destination);
	if (
		sourceCommand === null ||
		typeof sourceCommand !== "object" ||
		Array.isArray(sourceCommand)
	) {
		throw new TypeError("Command outbox command must be an object");
	}
	assertPublishedCommand(sourceCommand);
	assertOptionalNonBlank("correlationId", correlationId);
	assertOptionalNonBlank("conversationId", conversationId);
	assertTraceContext(traceparent, tracestate);

	const command = JSON.parse(JSON.stringify(sourceCommand)) as C;
	return deepFreeze({
		messageId: `${event.eventId}:command:${index}`,
		recordedAt: event.occurredAt.toISOString(),
		destination,
		command,
		...(correlationId === undefined ? {} : { correlationId }),
		...(conversationId === undefined ? {} : { conversationId }),
		...(traceparent === undefined ? {} : { traceparent }),
		...(tracestate === undefined ? {} : { tracestate }),
		causationId: event.eventId,
	}) as DurableCommandMessage<C>;
}

function assertNonBlank(
	field: string,
	value: unknown,
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		invalid(`$.${field}`, "must be a non-blank string");
	}
}

function assertOptionalNonBlank(field: string, value: unknown): void {
	if (value !== undefined) assertNonBlank(field, value);
}

function assertPublishedCommand(
	value: unknown,
): asserts value is PublishedCommand {
	assertJsonValue(value, "$.command", invalid);
	if (!isJsonObject(value)) {
		invalid("$.command", "must be a plain JSON object");
	}
	for (const key of Object.keys(value)) {
		if (key !== "type" && key !== "version" && key !== "payload") {
			invalid(
				`$.command.${key}`,
				"is not part of the published command schema",
			);
		}
	}
	assertNonBlank("command.type", value.type);
	if (
		typeof value.version !== "number" ||
		!Number.isInteger(value.version) ||
		value.version < 1
	) {
		invalid("$.command.version", "must be an integer >= 1");
	}
	if (!Object.hasOwn(value, "payload")) {
		invalid("$.command.payload", "is required (use null for an empty payload)");
	}
}

const TRACEPARENT =
	/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})([\x21-\x7e]*)$/;
const TRACESTATE_MEMBER =
	/^([a-z0-9][a-z0-9_@*/-]{0,255})=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{1,256}$/;

function assertTraceContext(traceparent: unknown, tracestate: unknown): void {
	if (traceparent === undefined) {
		if (tracestate !== undefined) {
			invalid("$.tracestate", "requires traceparent");
		}
		return;
	}
	if (typeof traceparent !== "string") {
		invalid("$.traceparent", "must be a W3C traceparent string");
	}
	const match = TRACEPARENT.exec(traceparent);
	const version = match?.[1];
	const extension = match?.[5] ?? "";
	if (
		match === null ||
		version === "ff" ||
		/^0+$/.test(match[2] ?? "") ||
		/^0+$/.test(match[3] ?? "") ||
		(version === "00" && extension.length > 0) ||
		(version !== "00" &&
			extension.length > 0 &&
			(!extension.startsWith("-") || extension.length === 1))
	) {
		invalid(
			"$.traceparent",
			"must be a structurally valid lowercase W3C traceparent",
		);
	}
	if (tracestate === undefined) return;
	if (typeof tracestate !== "string" || tracestate.length > 512) {
		invalid("$.tracestate", "must stay within the 512-character command limit");
	}
	// W3C Trace Context requires receivers to tolerate empty list-members
	// ("vendor1=abc,,vendor2=def"). They carry no data and are dropped
	// before validation; a header with only empty members counts as absent.
	const members = tracestate
		.split(",")
		.map((member) => member.trim())
		.filter((member) => member.length > 0);
	if (members.length === 0) return;
	const keys = new Set<string>();
	if (
		members.length > 32 ||
		members.some((member) => {
			const memberMatch = TRACESTATE_MEMBER.exec(member);
			const key = memberMatch?.[1];
			if (key === undefined || keys.has(key)) return true;
			keys.add(key);
			return false;
		})
	) {
		invalid(
			"$.tracestate",
			"must contain 1 to 32 unique, valid W3C tracestate list-members",
		);
	}
}

function invalid(path: string, reason: string): never {
	throw new InvalidCommandMessageError(path, reason);
}
