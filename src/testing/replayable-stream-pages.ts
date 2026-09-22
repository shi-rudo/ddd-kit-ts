import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../domain/event/domain-event";
import { assertPositiveSafeInteger } from "../internal/validate";
import type { ReplayableStreamPages } from "../persistence/event-store/stream-pages";

/** Options for {@link createReplayableStreamPages}. */
export interface CreateReplayableStreamPagesOptions<Evt extends AnyDomainEvent>
	extends Pick<ReplayableStreamPages<Evt>, "fromVersion" | "targetVersion"> {
	/** The events after the cursor through the target, in append order. */
	readonly tail: ReadonlyArray<Evt>;

	/**
	 * The maximum number of events per page. Without it, the tail comes back
	 * as one page. Set it to make a test cross a page boundary. Must be a
	 * positive safe integer when present.
	 */
	readonly limit?: number;
}

/**
 * Builds a replayable stream read from an in-memory tail, for a test of the
 * code that consumes a read: a repository, or the fold over a fixed window.
 * It stands in for a reader and does not test one. The tail is copied once
 * and comes back in the same pages on every iteration. An empty tail yields
 * no page, as the kit reader does.
 */
export function createReplayableStreamPages<Evt extends AnyDomainEvent>(
	stream: AggregateAddress,
	options: CreateReplayableStreamPagesOptions<Evt>,
): ReplayableStreamPages<Evt> {
	const limit = options.limit ?? Math.max(options.tail.length, 1);
	assertPositiveSafeInteger("createReplayableStreamPages", "limit", limit);
	const pages = sliceIntoPages(options.tail, limit);
	return {
		stream,
		fromVersion: options.fromVersion,
		targetVersion: options.targetVersion,
		pages: {
			[Symbol.asyncIterator]: () => yieldEachPage(pages),
		},
	};
}

function sliceIntoPages<Evt>(
	tail: ReadonlyArray<Evt>,
	limit: number,
): ReadonlyArray<ReadonlyArray<Evt>> {
	const pages: ReadonlyArray<Evt>[] = [];
	for (let start = 0; start < tail.length; start += limit) {
		pages.push(Object.freeze(tail.slice(start, start + limit)));
	}
	return pages;
}

async function* yieldEachPage<Evt>(
	pages: ReadonlyArray<ReadonlyArray<Evt>>,
): AsyncGenerator<ReadonlyArray<Evt>, void, undefined> {
	yield* pages;
}
