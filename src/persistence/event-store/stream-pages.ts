import { err, ok, type Result } from "@shirudo/result";
import type { ReplayableAggregate } from "../../domain/aggregate/aggregate";
import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import { assertReplayTargetHasNoPendingEvents } from "../../domain/aggregate/base-aggregate";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	type DomainError,
	NonProgressingEventStreamPageError,
	ReplayHeadMismatchError,
} from "../../errors/kit-errors";
import type { EventStore, ReadStreamOptions } from "./event-store";

/** Options for {@link readStreamPages}. */
export interface ReadStreamPagesOptions
	extends Pick<ReadStreamOptions, "limit" | "fromVersion"> {
	/**
	 * The stream position the replay must reach (inclusive, 1-based event
	 * count): a point-in-time read. Defaults to the stream head of the first
	 * page. A value beyond that head does not clamp. The read reports the
	 * window as unreachable instead, so a request for version 10 of a stream
	 * that ends at 7 never loads the latest state by accident.
	 * Must be a non-negative safe integer when present.
	 */
	readonly toVersion?: number;
}

/**
 * A stream read with the target pinned on its first page.
 *
 * The first page decides the stream state once, in three branches. An
 * absent stream is `exists: false` and carries nothing else. An existing
 * stream whose requested window lies outside it is `reachable: false` and
 * carries the actual head. The remaining branch exposes the pinned target
 * and the pages after the cursor. The caller decides what the first two
 * branches mean (not found, a snapshot to discard, a version the stream
 * has not reached) before it hands the last branch to
 * {@link reconstituteAggregateFromStreamPages}.
 */
export type StreamPages<Evt extends AnyDomainEvent> =
	| { readonly exists: false }
	| UnreachableStreamPages
	| ExistingStreamPages<Evt>;

/**
 * The branch of {@link StreamPages} for a window that lies outside the
 * stream: the cursor lies beyond the target, or the target lies beyond the
 * head. A derived snapshot outlived its stream, or a point-in-time read
 * asked for a version the stream has not reached.
 */
export interface UnreachableStreamPages {
	readonly exists: true;
	readonly reachable: false;

	/** The qualified stream the read addressed. */
	readonly stream: AggregateAddress;

	/** The actual stream head on the first page. */
	readonly lastVersion: number;
}

/** The branch of {@link StreamPages} that a replay can fold. */
export interface ExistingStreamPages<Evt extends AnyDomainEvent> {
	readonly exists: true;
	readonly reachable: true;

	/** The qualified stream the pages come from. */
	readonly stream: AggregateAddress;

	/** The actual stream head on the first page. */
	readonly lastVersion: number;

	/**
	 * The version a replay of the pages must end at: `toVersion` when the
	 * read asked for one, else the head pinned on the first page. Later
	 * appends do not move it.
	 */
	readonly targetVersion: number;

	/**
	 * The events after the cursor through the target, in append order, one
	 * bounded page per iteration. Every iteration starts again from the
	 * first page, so a second fold over one read sees the same prefix. The
	 * kit reader yields no empty page. It throws
	 * {@link NonProgressingEventStreamPageError} for a continuation page
	 * that makes no progress.
	 */
	readonly pages: AsyncIterable<ReadonlyArray<Evt>>;
}

/**
 * Reads one stream in bounded pages toward a pinned target.
 *
 * This call reads the first page. That page decides existence and reports
 * the head. The target is `toVersion` when given, else that head. A window
 * that lies outside the stream is reported as unreachable, never clamped.
 * Each iteration of `pages` reads the remaining pages lazily. The reader
 * bounds every continuation page to the target with `toVersion` and
 * continues by the number of events the previous page returned. Streams
 * are append-only, so that yields one stable prefix even when another
 * writer appends during the replay.
 *
 * The store rejects invalid options with `RangeError` before any page is
 * read.
 */
export async function readStreamPages<Evt extends AnyDomainEvent>(
	eventStore: EventStore<Evt>,
	stream: AggregateAddress,
	options: ReadStreamPagesOptions,
): Promise<StreamPages<Evt>> {
	const fromVersion = options.fromVersion ?? 0;
	const address: AggregateAddress = {
		aggregateType: stream.aggregateType,
		aggregateId: stream.aggregateId,
	};
	const first = await eventStore.readStream(address, {
		fromVersion,
		limit: options.limit,
		...(options.toVersion === undefined
			? {}
			: { toVersion: options.toVersion }),
	});
	if (!first.exists) return { exists: false };
	const lastVersion = first.lastVersion;
	const targetVersion = options.toVersion ?? lastVersion;
	if (fromVersion > targetVersion || targetVersion > lastVersion) {
		return { exists: true, reachable: false, stream: address, lastVersion };
	}
	const window: PinnedWindow<Evt> = {
		stream: address,
		firstPage: first.events,
		cursorAfterFirstPage: fromVersion + first.events.length,
		targetVersion,
		limit: options.limit,
	};
	return {
		exists: true,
		reachable: true,
		stream: address,
		lastVersion,
		targetVersion,
		pages: {
			[Symbol.asyncIterator]: () => continueToPinnedTarget(eventStore, window),
		},
	};
}

interface PinnedWindow<Evt extends AnyDomainEvent> {
	readonly stream: AggregateAddress;
	readonly firstPage: ReadonlyArray<Evt>;
	readonly cursorAfterFirstPage: number;
	readonly targetVersion: number;
	readonly limit: number;
}

async function* continueToPinnedTarget<Evt extends AnyDomainEvent>(
	eventStore: EventStore<Evt>,
	window: PinnedWindow<Evt>,
): AsyncGenerator<ReadonlyArray<Evt>, void, undefined> {
	if (window.firstPage.length > 0) yield window.firstPage;
	let cursor = window.cursorAfterFirstPage;
	while (cursor < window.targetVersion) {
		const page = await eventStore.readStream(window.stream, {
			fromVersion: cursor,
			toVersion: window.targetVersion,
			limit: window.limit,
		});
		if (!page.exists || page.events.length === 0) {
			throw new NonProgressingEventStreamPageError({
				...window.stream,
				fromVersion: cursor,
				targetVersion: window.targetVersion,
			});
		}
		yield page.events;
		cursor += page.events.length;
	}
}

/**
 * Reconstitutes an event-sourced aggregate from the pages of a stream read
 * and yields it only when the replay ended at the pinned target.
 *
 * This is the paged form of `reconstituteAggregateFromHistory`.
 * `createReplayTarget` builds the instance: a fresh one for a full replay,
 * or one restored from a snapshot for a read that started at
 * `snapshot.version`. The target must carry no pending decisions. A dirty
 * target throws `UnreplayableAggregateError` before the first page, as
 * `replayHistory` does. Each page then goes through `replayHistory` on that
 * instance, so allocation stays bounded by the page limit. `replayHistory`
 * rolls back one page. On a rejected page the earlier pages stay folded on
 * the instance, and that instance never escapes: the `DomainError` rides
 * the `Result`. Wiring errors and a foreign row throw, as in
 * `replayHistory`. The creator runs outside the `Result`.
 *
 * Events carry no stream position, so the instance cannot detect a tail
 * that overlaps or misses its restored version. The call therefore checks
 * the final version against `read.targetVersion` and throws
 * {@link ReplayHeadMismatchError} on a mismatch.
 */
export async function reconstituteAggregateFromStreamPages<
	TAggregate extends ReplayableAggregate<Id<string>, AnyDomainEvent>,
>(
	createReplayTarget: () => TAggregate,
	read: ExistingStreamPages<Parameters<TAggregate["replayHistory"]>[0][number]>,
): Promise<Result<TAggregate, DomainError>> {
	const aggregate = createReplayTarget();
	// A read without pages never reaches replayHistory, so its guard runs
	// here too: a dirty target must fail as a wiring error, never as a head
	// mismatch that a snapshot recipe would answer with a refold.
	assertReplayTargetHasNoPendingEvents(
		aggregate.id,
		aggregate.pendingEvents.length,
	);
	for await (const page of read.pages) {
		const replayed = aggregate.replayHistory(page);
		if (replayed.isErr()) return err(replayed.error);
	}
	if (aggregate.version !== read.targetVersion) {
		throw new ReplayHeadMismatchError({
			...read.stream,
			targetVersion: read.targetVersion,
			actualVersion: aggregate.version,
		});
	}
	return ok(aggregate);
}
