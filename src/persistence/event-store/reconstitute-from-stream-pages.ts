import { err, ok, type Result } from "@shirudo/result";
import type { ReplayableAggregate } from "../../domain/aggregate/aggregate";
import type { AggregateIdentity } from "../../domain/aggregate/aggregate-identity";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	InvalidEventStreamPageError,
	ReplayRejectedError,
	ReplayTargetMismatchError,
} from "../../errors/kit-errors";
import {
	assertNonNegativeSafeInteger,
	assertPositiveSafeInteger,
} from "../../internal/validate";
import {
	assertPageNotEmpty,
	assertPageWithinWindow,
} from "./event-stream-page-guards";

/**
 * The shape the replay reads: the stream, the window, and the pages.
 * `readStreamPages` returns it as the reachable branch of a kit read. An
 * adapter that pages on its own builds it directly, after it pinned the
 * target version with `pinTargetVersion`.
 */
export interface ReplayableStreamPages<Evt extends AnyDomainEvent> {
	/** The qualified stream the pages come from. */
	readonly stream: AggregateIdentity;

	/**
	 * The cursor the read started at: `fromVersion`, or `0`. The pages hold
	 * the events after it, so the replay target must stand at this version.
	 */
	readonly fromVersion: number;

	/**
	 * The version the replay must end at: the head at read time, or a
	 * `toVersion` at or below it. Never a version taken from a snapshot, and
	 * never below `fromVersion`. Later appends do not move it.
	 */
	readonly targetVersion: number;

	/**
	 * The events after the cursor through the target version, in append
	 * order, one bounded page per iteration. Every iteration starts again
	 * from the first page, so a second replay of one read sees the same
	 * prefix. A page holds at least one event, and the pages end at the
	 * target version. The replay rejects an empty page, and a page that
	 * would run past the target version, with
	 * {@link InvalidEventStreamPageError} before any row of it reaches the
	 * aggregate. `createReplayableStreamPagesContractTests` proves these
	 * rules for an adapter.
	 *
	 * The events of a page are stored facts: no consumer, upcaster, or fold
	 * changes one in place. `readStreamPages` reads fresh events on every
	 * later iteration, and `createReplayableStreamPages` hands out frozen
	 * ones, so a consumer that breaks this rule fails in its own tests.
	 */
	readonly pages: AsyncIterable<ReadonlyArray<Evt>>;
}

/**
 * Reconstitutes an event-sourced aggregate from the pages of a stream read
 * and yields it only when the replay ends at the target version.
 *
 * This is the paged form of `reconstituteAggregateFromHistory`.
 * `createReplayTarget` builds the replay target: a fresh instance for a
 * full replay, or an instance reconstituted from a snapshot for a read that
 * starts at `snapshot.version`. `read` is the reachable branch of a kit
 * read, or the value that an adapter that pages on its own built.
 *
 * The call checks the window first. `targetVersion` must be a positive
 * safe integer, and `fromVersion` a non-negative one at or below it. A bad
 * window rejects with `RangeError` before the replay target is built.
 *
 * The call then primes the replay target with an empty history, so the
 * aggregate runs its own guard even when the read holds no page: a replay
 * target with pending decisions throws `UnreplayableAggregateError`. The
 * replay target must stand at `read.fromVersion`. A replay target at
 * another version throws {@link ReplayTargetMismatchError} before the
 * first page, even when it also rejected the empty history: a wiring
 * defect wins over a rejection that the data cannot explain.
 *
 * Each page goes through `replayHistory` on the replay target, so
 * allocation stays bounded by the size of a page; `readStreamPages` rejects
 * a page over its `limit`. An empty page, and a page that would run past
 * the target version, throw {@link InvalidEventStreamPageError} before any
 * row of them reaches the aggregate. Events carry no stream position, so
 * only the call can find pages that end short of the target version. After
 * the last page it compares the final version with `read.targetVersion` and
 * throws {@link ReplayTargetMismatchError} on a difference.
 *
 * When the aggregate rejects a stored event with a `DomainError`, the call
 * stops reading and returns {@link ReplayRejectedError} as `Err`. The
 * error names the stream and the window of the rejected page, and it holds
 * the `DomainError` as `cause`. The replay target never escapes on that
 * path. Wiring errors and a foreign row throw, as in `replayHistory`. What
 * `createReplayTarget` throws propagates.
 */
export async function reconstituteAggregateFromStreamPages<
	TAggregate extends ReplayableAggregate<Id<string>, AnyDomainEvent>,
>(
	createReplayTarget: () => TAggregate,
	read: ReplayableStreamPages<
		Parameters<TAggregate["replayHistory"]>[0][number]
	>,
): Promise<Result<TAggregate, ReplayRejectedError>> {
	assertNonNegativeSafeInteger(
		"reconstituteAggregateFromStreamPages",
		"fromVersion",
		read.fromVersion,
	);
	assertPositiveSafeInteger(
		"reconstituteAggregateFromStreamPages",
		"targetVersion",
		read.targetVersion,
	);
	if (read.fromVersion > read.targetVersion) {
		throw new RangeError(
			"reconstituteAggregateFromStreamPages: fromVersion must not exceed " +
				`targetVersion, got ${read.fromVersion} > ${read.targetVersion}`,
		);
	}
	const aggregate = createReplayTarget();
	const primed = aggregate.replayHistory([]);
	if (aggregate.version !== read.fromVersion) {
		throw new ReplayTargetMismatchError({
			...read.stream,
			reason: "target_not_at_cursor",
			fromVersion: read.fromVersion,
			targetVersion: read.targetVersion,
			actualVersion: aggregate.version,
		});
	}
	if (primed.isErr()) {
		return err(
			new ReplayRejectedError({
				...read.stream,
				fromVersion: aggregate.version,
				toVersion: aggregate.version,
				cause: primed.error,
			}),
		);
	}
	for await (const page of read.pages) {
		assertPageNotEmpty(
			read.stream,
			page.length,
			aggregate.version,
			read.targetVersion,
		);
		assertPageWithinWindow(
			read.stream,
			page.length,
			aggregate.version,
			read.targetVersion,
		);
		const versionBeforePage = aggregate.version;
		const replayed = aggregate.replayHistory(page);
		if (replayed.isErr()) {
			return err(
				new ReplayRejectedError({
					...read.stream,
					fromVersion: versionBeforePage,
					toVersion: versionBeforePage + page.length,
					cause: replayed.error,
				}),
			);
		}
	}
	if (aggregate.version !== read.targetVersion) {
		throw new ReplayTargetMismatchError({
			...read.stream,
			reason: "pages_short_of_target",
			fromVersion: read.fromVersion,
			targetVersion: read.targetVersion,
			actualVersion: aggregate.version,
		});
	}
	return ok(aggregate);
}
