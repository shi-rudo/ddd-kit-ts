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

/**
 * Options for {@link readStreamPages}: the `limit` and `fromVersion` of
 * {@link ReadStreamOptions}. `toVersion` is not accepted, because the read
 * pins its own upper bound: the stream head of the first page.
 */
export type ReadStreamPagesOptions = Omit<ReadStreamOptions, "toVersion"> & {
	readonly toVersion?: never;
};

/**
 * A stream read with the head pinned on its first page.
 *
 * The first page decides the stream state once. An absent stream is the
 * `exists: false` branch and carries nothing else. An existing stream
 * exposes the pinned head and the pages after the cursor. The caller
 * decides what absence means (not found, or a snapshot to discard) before
 * it hands the existing branch to
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
	 * pages must end at. Later appends do not move it. A cursor beyond this
	 * head means a derived snapshot outlived its stream. The pages are then
	 * empty, and the replay fails the head check.
	 */
	readonly targetVersion: number;

	/**
	 * The events after the cursor through the pinned head, in append order,
	 * one bounded page per iteration. Every iteration starts again from the
	 * first page, so a second fold over one read sees the same prefix. The
	 * kit reader yields no empty page. It throws
	 * {@link NonProgressingEventStreamPageError} for a continuation page
	 * that makes no progress.
	 */
	readonly pages: AsyncIterable<ReadonlyArray<Evt>>;
}

/**
 * Reads one stream in bounded pages toward the head pinned on the first
 * page.
 *
 * This call reads the first page. That page decides existence and pins
 * `lastVersion` as `targetVersion`. Each iteration of `pages` reads the
 * remaining pages lazily. The reader bounds every continuation page to the
 * pinned head with `toVersion` and continues by the number of events the
 * previous page returned. Streams are append-only, so that yields one
 * stable prefix even when another writer appends during the replay.
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
	});
	if (!first.exists) return { exists: false };
	const window: PinnedWindow<Evt> = {
		stream: address,
		firstPage: first.events,
		cursorAfterFirstPage: fromVersion + first.events.length,
		targetVersion: first.lastVersion,
		limit: options.limit,
	};
	return {
		exists: true,
		stream: address,
		targetVersion: first.lastVersion,
		pages: {
			[Symbol.asyncIterator]: () => continueToPinnedHead(eventStore, window),
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

async function* continueToPinnedHead<Evt extends AnyDomainEvent>(
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
 * and yields it only when the replay ended at the pinned head.
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
