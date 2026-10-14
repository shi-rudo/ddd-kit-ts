/**
 * A command outbox double for the kit's own tests. Internal to the testing
 * entry: not re-exported from `@shirudo/ddd-kit/testing`.
 */
import type { PublishedCommand } from "../application/cqrs/command/command";
import type {
	CommandOutboxCommitCandidate,
	CommandOutboxWriter,
} from "../application/cqrs/command/command-outbox";
import type { AggregateIdentity } from "../domain/aggregate/aggregate-identity";

/** A {@link CommandOutboxWriter} that keeps a copy of every batch that it gets. */
export interface RecordingCommandOutbox<C extends PublishedCommand>
	extends CommandOutboxWriter<C> {
	/** The commits of every `add` call, in call order. */
	readonly added: CommandOutboxCommitCandidate<C>[][];
	/** The sources of every `endEventSources` call, in call order. */
	readonly ended: AggregateIdentity[][];
}

/**
 * A command outbox that records `add` and `endEventSources`. A test
 * replaces only the methods that it needs; a replaced method records
 * nothing. Every method of the port has its default here, so a new port
 * method needs one default in this module and none in the tests.
 */
export function recordingCommandOutbox<C extends PublishedCommand>(
	overrides: Partial<CommandOutboxWriter<C>> = {},
): RecordingCommandOutbox<C> {
	const added: CommandOutboxCommitCandidate<C>[][] = [];
	const ended: AggregateIdentity[][] = [];
	return {
		added,
		ended,
		add: async (commits) => {
			added.push([...commits]);
		},
		endEventSources: async (sources) => {
			ended.push([...sources]);
		},
		...overrides,
	};
}
