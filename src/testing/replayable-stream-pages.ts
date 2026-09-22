import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../domain/event/domain-event";
import type { ReplayableStreamPages } from "../persistence/event-store/stream-pages";

/** Options for {@link createReplayableStreamPages}. */
export interface CreateReplayableStreamPagesOptions<Evt extends AnyDomainEvent>
	extends Pick<ReplayableStreamPages<Evt>, "fromVersion" | "targetVersion"> {
	/** The events after the cursor through the target, in append order. */
	readonly tail: ReadonlyArray<Evt>;
}

/**
 * Builds a replayable stream read from an in-memory tail, for a test of the
 * code that consumes a read: a repository, or the fold over a fixed window.
 * It stands in for a reader and does not test one. The tail is copied once
 * and comes back as one page on every iteration. An empty tail yields no
 * page, as the kit reader does.
 */
export function createReplayableStreamPages<Evt extends AnyDomainEvent>(
	stream: AggregateAddress,
	options: CreateReplayableStreamPagesOptions<Evt>,
): ReplayableStreamPages<Evt> {
	const page: ReadonlyArray<Evt> = Object.freeze([...options.tail]);
	return {
		stream,
		fromVersion: options.fromVersion,
		targetVersion: options.targetVersion,
		pages: {
			[Symbol.asyncIterator]: () => tailAsOnePage(page),
		},
	};
}

async function* tailAsOnePage<Evt>(
	page: ReadonlyArray<Evt>,
): AsyncGenerator<ReadonlyArray<Evt>, void, undefined> {
	if (page.length > 0) yield page;
}
