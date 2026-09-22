import { err, ok, type Result } from "@shirudo/result";
import type { ReplayableAggregate } from "../../domain/aggregate/aggregate";
import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
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

/**
 * The shape a replay folds: the stream, the window, and the pages.
 * `readStreamPages` returns it as the reachable branch of
 * {@link StreamPages}; an adapter that pages on its own builds it directly.
 */
export interface ReplayableStreamPages<Evt extends AnyDomainEvent> {
	/** The qualified stream the pages come from. */
	readonly stream: AggregateAddress;

	/**
	 * The cursor the read started at: `fromVersion`, or `0`. The pages hold
	 * the events after it, so a replay target must start at this version.
	 */
	readonly fromVersion: number;

	/**
	 * The version a replay of the pages must end at: the stream head at read
	 * time, or a `toVersion` at or below it. Never a version taken from a
	 * snapshot, and never below `fromVersion`. Later appends do not move it.
	 */
	readonly targetVersion: number;

	/**
	 * The events after the cursor through the target, in append order, one
	 * bounded page per iteration. Every iteration starts again from the
	 * first page, so a second fold over one read sees the same prefix. A
	 * page holds at least one event, and the pages end at the target. The
	 * fold rejects an empty page, and a page that would run past the target,
	 * with {@link InvalidEventStreamPageError} before it folds that page.
	 */
	readonly pages: AsyncIterable<ReadonlyArray<Evt>>;
}

/**
 * Reconstitutes an event-sourced aggregate from the pages of a stream read
 * and yields it only when the replay ends at the target version.
 *
 * This is the paged form of `reconstituteAggregateFromHistory`.
 * `createReplayTarget` builds the replay target: a fresh instance for a
 * full replay, or an instance restored from a snapshot for a read that
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
 * first page.
 *
 * Each page goes through `replayHistory` on the replay target, so
 * allocation stays bounded by the page limit. An empty page, and a page
 * that would run past the target version, throw
 * {@link InvalidEventStreamPageError} before any row of them reaches the
 * aggregate. Events carry no stream position, so only the call can find
 * pages that end short of the target version. After the last page it
 * compares the final version with `read.targetVersion` and throws
 * {@link ReplayTargetMismatchError} on a difference.
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
	if (aggregate.version !== read.fromVersion) {
		throw new ReplayTargetMismatchError({
			...read.stream,
			reason: "target_not_at_cursor",
			fromVersion: read.fromVersion,
			targetVersion: read.targetVersion,
			actualVersion: aggregate.version,
		});
	}
	for await (const page of read.pages) {
		if (page.length === 0) {
			throw new InvalidEventStreamPageError({
				...read.stream,
				reason: "empty_page",
				fromVersion: aggregate.version,
				targetVersion: read.targetVersion,
			});
		}
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

export function assertPageWithinWindow(
	stream: AggregateAddress,
	eventCount: number,
	fromVersion: number,
	targetVersion: number,
): void {
	if (eventCount <= targetVersion - fromVersion) return;
	throw new InvalidEventStreamPageError({
		...stream,
		reason: "page_past_target",
		fromVersion,
		targetVersion,
		eventCount,
	});
}
