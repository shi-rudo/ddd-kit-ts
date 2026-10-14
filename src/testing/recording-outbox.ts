/**
 * An outbox double for the kit's own tests. Internal to the testing entry:
 * not re-exported from `@shirudo/ddd-kit/testing`.
 */
import type { AggregateIdentity } from "../domain/aggregate/aggregate-identity";
import type { AnyDomainEvent } from "../domain/event/domain-event";
import type { EventCommitCandidate } from "../messaging/committed-event";
import type { Outbox } from "../messaging/outbox/ports";

/** An {@link Outbox} that keeps a copy of every batch that it gets. */
export interface RecordingOutbox<Evt extends AnyDomainEvent>
	extends Outbox<Evt> {
	/** The candidates of every `add` call, in call order. */
	readonly added: EventCommitCandidate<Evt>[][];
	/** The sources of every `endEventSources` call, in call order. */
	readonly ended: AggregateIdentity[][];
}

/**
 * An outbox that records `add` and `endEventSources`, has no pending
 * records, and accepts every acknowledgement. A test replaces only the
 * methods that it needs; a replaced method records nothing. Every method of
 * the port has its default here, so a new port method needs one default in
 * this module and none in the tests.
 */
export function recordingOutbox<Evt extends AnyDomainEvent>(
	overrides: Partial<Outbox<Evt>> = {},
): RecordingOutbox<Evt> {
	const added: EventCommitCandidate<Evt>[][] = [];
	const ended: AggregateIdentity[][] = [];
	return {
		added,
		ended,
		add: async (events) => {
			added.push([...events]);
		},
		endEventSources: async (sources) => {
			ended.push([...sources]);
		},
		getPending: async () => [],
		markDispatched: async () => {},
		...overrides,
	};
}
