import { err, ok, type Result } from "@shirudo/result";
import type { ReplayableAggregate } from "../../domain/aggregate/aggregate";
import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import type { Id } from "../../domain/identity/id";
import {
	type DomainError,
	NonProgressingEventStreamPageError,
	ReplayHeadMismatchError,
} from "../../errors/kit-errors";
import type { EventStore } from "./event-store";

/** Options for {@link readStreamPages}. */
export interface ReadStreamPagesOptions {
	/**
	 * Maximum number of events per page; the same bound as
	 * `ReadStreamOptions.limit`. Must be a positive safe integer.
	 */
	readonly limit: number;

	/**
	 * Return only events AFTER this stream position (1-based event count):
	 * the snapshot catch-up cursor, `snapshot.version`. Defaults to `0`,
	 * the whole stream. Must be a non-negative safe integer when present.
	 */
	readonly fromVersion?: number;
}

/**
 * A stream read with the head pinned on its first page.
 *
 * The stream state is decided once, on the first page: an absent stream is
 * the `exists: false` branch and carries nothing else. An existing stream
 * exposes the pinned head and the pages after the cursor as one lazy,
 * single-pass iteration. A caller decides what absence means (not found,
 * or a snapshot to discard) before it hands the existing branch to
 * {@link reconstituteAggregateFromStreamPages}.
 */
export type StreamPages<Evt extends AnyDomainEvent> =
	| { readonly exists: false }
	| ExistingStreamPages<Evt>;

/** The existing-stream branch of {@link StreamPages}. */
export interface ExistingStreamPages<Evt extends AnyDomainEvent> {
	readonly exists: true;

	/** The qualified stream the pages come from. */
	readonly stream: AggregateAddress;

	/**
	 * The stream head pinned on the first page: the version a replay of the
	 * pages must end at. Later appends do not move it. When the cursor of
	 * the read lies beyond this head, the stream was truncated or replaced
	 * behind a derived snapshot; the pages are then empty and the replay
	 * fails the head check.
	 */
	readonly targetVersion: number;

	/**
	 * The events after the cursor through the pinned head, in append order,
	 * one bounded page per iteration. Every page holds at least one event,
	 * and the iteration is single-pass. A continuation page that makes no
	 * progress throws {@link NonProgressingEventStreamPageError}.
	 */
	readonly pages: AsyncIterable<ReadonlyArray<Evt>>;
}

/**
 * Reads one stream in bounded pages toward the head pinned on the first
 * page.
 *
 * The first page is read here; it decides existence and pins
 * `lastVersion` as the target. The remaining pages are read lazily while
 * the returned `pages` is iterated, each one bounded to the pinned head by
 * `toVersion` and continued by the number of events the previous page
 * returned. Because streams are append-only, that yields one stable
 * prefix even when another writer appends during the replay.
 *
 * Invalid options reject with `RangeError` from the store, before any
 * page is read.
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
	});
	if (!first.exists) return { exists: false };
	const targetVersion = first.lastVersion;
	return {
		exists: true,
		stream: address,
		targetVersion,
		pages: continueToPinnedHead(
			eventStore,
			address,
			first.events,
			fromVersion + first.events.length,
			targetVersion,
			options.limit,
		),
	};
}

async function* continueToPinnedHead<Evt extends AnyDomainEvent>(
	eventStore: EventStore<Evt>,
	stream: AggregateAddress,
	firstPage: ReadonlyArray<Evt>,
	cursorAfterFirstPage: number,
	targetVersion: number,
	limit: number,
): AsyncGenerator<ReadonlyArray<Evt>, void, undefined> {
	if (firstPage.length > 0) yield firstPage;
	let cursor = cursorAfterFirstPage;
	while (cursor < targetVersion) {
		const page = await eventStore.readStream(stream, {
			fromVersion: cursor,
			toVersion: targetVersion,
			limit,
		});
		if (!page.exists || page.events.length === 0) {
			throw new NonProgressingEventStreamPageError({
				...stream,
				fromVersion: cursor,
				targetVersion,
			});
		}
		yield page.events;
		cursor += page.events.length;
	}
}

type ReplayedEventOf<
	TAggregate extends ReplayableAggregate<Id<string>, AnyDomainEvent>,
> = Parameters<TAggregate["replayHistory"]>[0][number];

/**
 * Reconstitutes an event-sourced aggregate from the pages of a stream read
 * and yields it only when the replay ended at the pinned head.
 *
 * The async form of `reconstituteAggregateFromHistory`. `createReplayTarget`
 * builds the instance: a fresh one for a full replay, or one restored from a
 * snapshot for a catch-up read that started at `snapshot.version`. Every
 * page goes through `replayHistory` on that instance, so allocation stays
 * bounded by the page limit. A `DomainError` from a fold rides the
 * `Result`; the instance never escapes then. Wiring errors and a foreign
 * row throw, as in `replayHistory`, and the creator runs outside the
 * `Result`.
 *
 * Events carry no stream position, so the instance cannot detect a tail
 * that overlaps or misses its restored version. The final version is
 * therefore checked against `read.targetVersion`; a mismatch throws
 * {@link ReplayHeadMismatchError}.
 */
export async function reconstituteAggregateFromStreamPages<
	TAggregate extends ReplayableAggregate<Id<string>, AnyDomainEvent>,
>(
	createReplayTarget: () => TAggregate,
	read: ExistingStreamPages<ReplayedEventOf<TAggregate>>,
): Promise<Result<TAggregate, DomainError>> {
	const aggregate = createReplayTarget();
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
