import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../domain/event/domain-event";
import type { ExistingStreamPages } from "../persistence/event-store/stream-pages";

/**
 * A stream read hand-built from an in-memory tail, for a test of a fold
 * that pages on its own. The tail holds the events after the cursor
 * through `targetVersion`, in append order. It comes back as one page on
 * every iteration. An empty tail yields no page, as the kit reader does.
 */
export function inMemoryStreamPages<Evt extends AnyDomainEvent>(
	stream: AggregateAddress,
	tail: ReadonlyArray<Evt>,
	targetVersion: number,
): ExistingStreamPages<Evt> {
	return {
		exists: true,
		reachable: true,
		stream,
		targetVersion,
		pages: {
			[Symbol.asyncIterator]: () => onePage(tail),
		},
	};
}

async function* onePage<Evt>(
	tail: ReadonlyArray<Evt>,
): AsyncGenerator<ReadonlyArray<Evt>, void, undefined> {
	if (tail.length > 0) yield tail;
}
