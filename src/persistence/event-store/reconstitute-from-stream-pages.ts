import { err, ok, type Result } from "@shirudo/result";
import type { ReplayableAggregate } from "../../domain/aggregate/aggregate";
import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	type DomainError,
	NonProgressingEventStreamPageError,
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
	 * fold rejects an empty page with
	 * {@link NonProgressingEventStreamPageError}, and a page that would run
	 * past the target with {@link ReplayTargetMismatchError} before it folds
	 * that page.
	 */
	readonly pages: AsyncIterable<ReadonlyArray<Evt>>;
}

/**
 * Reconstitutes an event-sourced aggregate from the pages of a stream read
 * and yields it only when the replay ended at the pinned target.
 *
 * This is the paged form of `reconstituteAggregateFromHistory`.
 * `createReplayTarget` builds the instance: a fresh one for a full replay,
 * or one restored from a snapshot for a read that started at
 * `snapshot.version`. `read` is a {@link ReplayableStreamPages}: the
 * reachable branch of a kit read, or the value an adapter that pages on its
 * own built. The target must
 * carry no pending decisions. The fold
 * primes it with an empty history first, so the aggregate runs its own
 * replay-target guard even when the read holds no page; a dirty target
 * throws `UnreplayableAggregateError` as `replayHistory` does. The target
 * must then stand at the read cursor, `read.fromVersion`; a target at
 * another version throws {@link ReplayTargetMismatchError} before any page
 * is read. Each page goes through `replayHistory` on that instance, so
 * allocation stays bounded by the page limit. An empty page throws
 * {@link NonProgressingEventStreamPageError}. A page that would run past
 * the target throws {@link ReplayTargetMismatchError} before it is folded,
 * so no row of it reaches the aggregate. An adapter that yields an empty
 * page, or one that overshoots, therefore fails instead of looping. The
 * fold validates the window first: `targetVersion` is a
 * positive safe integer, `fromVersion` a non-negative one at or below it; a
 * bad window rejects with `RangeError` before the target is built.
 * `replayHistory` rolls back
 * one page. On a rejected page the earlier pages stay folded on the
 * instance, and that instance never escapes: the `DomainError` rides the
 * `Result`. Wiring errors and a foreign row throw, as in `replayHistory`.
 * The creator runs outside the `Result`.
 *
 * Events carry no stream position, so the instance cannot detect pages
 * that end short of the target. The call therefore checks the final
 * version against `read.targetVersion` and throws
 * {@link ReplayTargetMismatchError} when the pages ended early.
 */
export async function reconstituteAggregateFromStreamPages<
	TAggregate extends ReplayableAggregate<Id<string>, AnyDomainEvent>,
>(
	createReplayTarget: () => TAggregate,
	read: ReplayableStreamPages<
		Parameters<TAggregate["replayHistory"]>[0][number]
	>,
): Promise<Result<TAggregate, DomainError>> {
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
	if (primed.isErr()) return err(primed.error);
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
			throw new NonProgressingEventStreamPageError({
				...read.stream,
				reason: "empty_page",
				fromVersion: aggregate.version,
				targetVersion: read.targetVersion,
			});
		}
		if (aggregate.version + page.length > read.targetVersion) {
			throw new ReplayTargetMismatchError({
				...read.stream,
				reason: "pages_outside_window",
				fromVersion: read.fromVersion,
				targetVersion: read.targetVersion,
				actualVersion: aggregate.version + page.length,
			});
		}
		const replayed = aggregate.replayHistory(page);
		if (replayed.isErr()) return err(replayed.error);
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
