import type { AggregateAddress } from "../aggregate/aggregate-address";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import type {
	EventCommitCandidate,
	EventCommitCandidatePosition,
	OutboxWriter,
} from "../events/ports";
import { deepFreeze } from "../value-object/value-object";
import type { Command } from "./command";

/** Trace relationships selected explicitly for an outgoing command. */
export interface CommandMessageRelationships {
	/** Groups messages that belong to one operation or trace. */
	readonly correlationId?: string;
	/** Groups every message in one long-running business interaction. */
	readonly conversationId?: string;
}

/**
 * Application-owned command content produced from one private domain or
 * process event. `destination` names one receiver contract; it is deliberately
 * required because a command is an instruction, not a broadcast fact.
 */
export interface CommandMessageContent<C extends Command>
	extends CommandMessageRelationships {
	readonly destination: string;
	readonly command: C;
}

/**
 * Immutable command envelope stored for later at-least-once delivery.
 *
 * `causationId` always identifies the private event whose accepted decision
 * requested this command. The mapper cannot replace it with a weaker
 * correlation. Consumer-produced events should in turn use `messageId` as
 * their causation id.
 */
export interface DurableCommandMessage<C extends Command>
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
export interface CommandOutboxCommitCandidate<C extends Command> {
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
export interface CommandOutboxWriter<C extends Command> {
	add(commits: ReadonlyArray<CommandOutboxCommitCandidate<C>>): Promise<void>;
}

/** Maps one private accepted event to zero or more addressed commands. */
export type CommandOutboxMapper<
	Evt extends AnyDomainEvent,
	C extends Command,
> = (event: Evt) => ReadonlyArray<CommandMessageContent<C>>;

/**
 * Adapts a dedicated command outbox to the event-candidate write port consumed
 * by `withCommit`.
 *
 * Mapping happens inside the transaction, before the command outbox write.
 * The private event is used only at this boundary and is reduced to an origin
 * receipt. The helper never publishes it or copies its payload implicitly; the
 * application mapper selects the data that belongs in the command contract.
 * Every command gets a stable id derived from the event id and its zero-based
 * order, so an exact transaction retry produces the same rows.
 *
 * Omit `withCommit`'s in-process `bus` for private process events. Participants
 * consume the durable command messages from their explicitly named
 * destinations, while event-stream replay only rebuilds process state.
 */
export function routeEventsToCommandOutbox<
	C extends Command,
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

function toCommandCommit<Evt extends AnyDomainEvent, C extends Command>(
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

function toDurableCommand<C extends Command>(
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
	} = content;
	assertNonBlank("destination", destination);
	if (
		sourceCommand === null ||
		typeof sourceCommand !== "object" ||
		Array.isArray(sourceCommand)
	) {
		throw new TypeError("Command outbox command must be an object");
	}
	assertNonBlank("command.type", sourceCommand.type);
	assertOptionalNonBlank("correlationId", correlationId);
	assertOptionalNonBlank("conversationId", conversationId);

	const command = structuredClone(sourceCommand);
	return deepFreeze({
		messageId: `${event.eventId}:command:${index}`,
		recordedAt: event.occurredAt.toISOString(),
		destination,
		command,
		...(correlationId === undefined ? {} : { correlationId }),
		...(conversationId === undefined ? {} : { conversationId }),
		causationId: event.eventId,
	}) as DurableCommandMessage<C>;
}

function assertNonBlank(
	field: string,
	value: unknown,
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`Command outbox ${field} must be a non-blank string`);
	}
}

function assertOptionalNonBlank(field: string, value: unknown): void {
	if (value !== undefined) assertNonBlank(field, value);
}
