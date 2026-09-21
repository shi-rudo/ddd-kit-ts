import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../domain/event/domain-event";
import type { ReplayableStreamPages } from "../persistence/event-store/stream-pages";

/** The window a hand-built stream read covers. */
export interface InMemoryStreamPagesWindow<Evt extends AnyDomainEvent> {
	/** The cursor the read starts at; the replay target must stand here. */
	readonly fromVersion: number;
	/** The events after the cursor through the target, in append order. */
	readonly tail: ReadonlyArray<Evt>;
	/** The version the replay must end at. */
	readonly targetVersion: number;
}

/**
 * Builds a stream read from an in-memory tail, for a test of a reader that
 * pages on its own or of a fold over a fixed window. The tail comes back as
 * one page on every iteration. An empty tail yields no page, as the kit
 * reader does.
 */
export function createInMemoryStreamPages<Evt extends AnyDomainEvent>(
	stream: AggregateAddress,
	window: InMemoryStreamPagesWindow<Evt>,
): ReplayableStreamPages<Evt> {
	return {
		stream,
		fromVersion: window.fromVersion,
		targetVersion: window.targetVersion,
		pages: {
			[Symbol.asyncIterator]: () => onePage(window.tail),
		},
	};
}

async function* onePage<Evt>(
	tail: ReadonlyArray<Evt>,
): AsyncGenerator<ReadonlyArray<Evt>, void, undefined> {
	if (tail.length > 0) yield tail;
}
