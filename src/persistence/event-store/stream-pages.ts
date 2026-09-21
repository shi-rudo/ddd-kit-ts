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
import { assertPositiveSafeInteger } from "../../internal/validate";
import type { EventStore, ReadStreamOptions } from "./event-store";

/** Options for {@link readStreamPages}. */
export interface ReadStreamPagesOptions
	extends Pick<ReadStreamOptions, "limit" | "fromVersion"> {
	/**
	 * The stream position the replay must reach (inclusive, 1-based event
	 * count): a point-in-time read. Defaults to the stream head of the first
	 * page. A value beyond that head does not clamp. The read reports the
	 * window as unreachable instead. So a request for version 10 of a stream
	 * that ends at 7 never loads the latest state by accident.
	 * Must be a positive safe integer when present. Version 0 is the state
	 * before the first event, and no replay can end there.
	 */
	readonly toVersion?: number;

	/**
	 * Cooperative-cancellation signal, the one `UnitOfWork.run` carries. The
	 * reader polls it before the first page and before every continuation
	 * page and throws its `reason` once it is aborted. A page read in
	 * flight completes on its own, because the port takes no signal.
	 */
	readonly signal?: AbortSignal;
}

/**
 * A stream read with the target pinned on its first page.
 *
 * The first page decides the stream state once, in three branches. An
 * absent stream is `exists: false`. An existing stream whose requested
 * window lies outside it is `reachable: false` and carries the actual
 * head. The remaining branch exposes the pinned target and the pages after
 * the cursor. Both unreachable branches carry `reachable: false`, so one
 * guard narrows to the branch a fold accepts. The caller decides what the
 * first two branches mean before it hands the last branch to
 * {@link reconstituteAggregateFromStreamPages}.
 */
export type StreamPages<Evt extends AnyDomainEvent> =
	| AbsentStreamPages
	| UnreachableStreamPages
	| ReachableStreamPages<Evt>;

/** The branch of {@link StreamPages} for a stream the store does not hold. */
export interface AbsentStreamPages {
	readonly exists: false;
	readonly reachable: false;
}

/**
 * The branch of {@link StreamPages} for a window that lies outside an
 * existing stream: the cursor lies beyond the target, or the target lies
 * beyond the head.
 *
 * The caller tells the causes apart from its own inputs. A snapshot
 * version above `lastVersion` means the snapshot outlived its stream:
 * discard it and refold. A `toVersion` above `lastVersion` means the
 * stream has not reached that version: answer not found and keep the
 * snapshot. A snapshot version above `toVersion` means the snapshot is too
 * new for the request: keep it and refold from zero up to `toVersion`.
 */
export interface UnreachableStreamPages {
	readonly exists: true;
	readonly reachable: false;

	/** The cursor the read started at: `fromVersion`, or `0`. */
	readonly fromVersion: number;

	/** The actual stream head on the first page. */
	readonly lastVersion: number;
}

/**
 * The shape a replay folds: the stream, the window, and the pages. The kit
 * reader returns it as the reachable branch of {@link StreamPages}; a
 * reader that pages on its own builds it directly.
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
	 * The version a replay of the pages must end at. It is `toVersion` when
	 * the read asked for one, else the head pinned on the first page. Later
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

/** The branch of {@link StreamPages} that a replay can fold. */
export interface ReachableStreamPages<Evt extends AnyDomainEvent>
	extends ReplayableStreamPages<Evt> {
	readonly exists: true;
	readonly reachable: true;
}

/**
 * Reads one stream in bounded pages toward a pinned target.
 *
 * This call reads the first page. That page decides existence and reports
 * the head. The target is `toVersion` when given, else that head. The
 * reader never clamps a window that lies outside the stream. It reports
 * the window as unreachable. Each iteration of `pages` reads the remaining
 * pages lazily. The reader bounds every continuation page to the target
 * with `toVersion`. It continues by the number of events the previous page
 * returned. Streams are append-only, so that yields one stable prefix even
 * when another writer appends during the replay.
 *
 * A `toVersion` that is not a positive safe integer rejects with
 * `RangeError` before any page is read. The store rejects the other
 * invalid options the same way. An aborted `signal` rejects with its
 * reason before the next page.
 */
export async function readStreamPages<Evt extends AnyDomainEvent>(
	eventStore: Pick<EventStore<Evt>, "readStream">,
	stream: AggregateAddress,
	options: ReadStreamPagesOptions,
): Promise<StreamPages<Evt>> {
	if (options.toVersion !== undefined) {
		assertPositiveSafeInteger(
			"readStreamPages",
			"toVersion",
			options.toVersion,
		);
	}
	throwIfAborted(options.signal);
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
	if (!first.exists) return { exists: false, reachable: false };
	const lastVersion = first.lastVersion;
	const targetVersion = options.toVersion ?? lastVersion;
	if (fromVersion > targetVersion || targetVersion > lastVersion) {
		return { exists: true, reachable: false, fromVersion, lastVersion };
	}
	const window: PinnedWindow<Evt> = {
		stream: address,
		firstPage: first.events,
		cursorAfterFirstPage: fromVersion + first.events.length,
		targetVersion,
		limit: options.limit,
		signal: options.signal,
	};
	return {
		exists: true,
		reachable: true,
		stream: address,
		fromVersion,
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
	readonly signal: AbortSignal | undefined;
}

async function* continueToPinnedTarget<Evt extends AnyDomainEvent>(
	eventStore: Pick<EventStore<Evt>, "readStream">,
	window: PinnedWindow<Evt>,
): AsyncGenerator<ReadonlyArray<Evt>, void, undefined> {
	if (window.firstPage.length > 0) yield window.firstPage;
	let cursor = window.cursorAfterFirstPage;
	while (cursor < window.targetVersion) {
		throwIfAborted(window.signal);
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

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason;
}

/**
 * Reconstitutes an event-sourced aggregate from the pages of a stream read
 * and yields it only when the replay ended at the pinned target.
 *
 * This is the paged form of `reconstituteAggregateFromHistory`.
 * `createReplayTarget` builds the instance: a fresh one for a full replay,
 * or one restored from a snapshot for a read that started at
 * `snapshot.version`. `read` is the reachable branch of a kit read, or a
 * {@link ReplayableStreamPages} value a reader that pages on its own built;
 * the absent and unreachable branches lack the pages, so a caller decides
 * them before the fold. The target must carry no pending decisions. The fold
 * primes it with an empty history first, so the aggregate runs its own
 * replay-target guard even when the read holds no page; a dirty target
 * throws `UnreplayableAggregateError` as `replayHistory` does. The target
 * must then stand at the read cursor, `read.fromVersion`; a target at
 * another version throws {@link ReplayTargetMismatchError} before any page
 * is read. Each page goes through `replayHistory` on that instance, so
 * allocation stays bounded by the page limit. `replayHistory` rolls back
 * one page. On a rejected page the earlier pages stay folded on the
 * instance, and that instance never escapes: the `DomainError` rides the
 * `Result`. Wiring errors and a foreign row throw, as in `replayHistory`.
 * The creator runs outside the `Result`.
 *
 * Events carry no stream position, so the instance cannot detect a page
 * that lies outside the requested window. The call therefore checks the
 * final version against `read.targetVersion` and throws
 * {@link ReplayTargetMismatchError} on a mismatch.
 */
export async function reconstituteAggregateFromStreamPages<
	TAggregate extends ReplayableAggregate<Id<string>, AnyDomainEvent>,
>(
	createReplayTarget: () => TAggregate,
	read: ReplayableStreamPages<
		Parameters<TAggregate["replayHistory"]>[0][number]
	>,
): Promise<Result<TAggregate, DomainError>> {
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
		const replayed = aggregate.replayHistory(page);
		if (replayed.isErr()) return err(replayed.error);
	}
	if (aggregate.version !== read.targetVersion) {
		throw new ReplayTargetMismatchError({
			...read.stream,
			reason: "pages_outside_window",
			fromVersion: read.fromVersion,
			targetVersion: read.targetVersion,
			actualVersion: aggregate.version,
		});
	}
	return ok(aggregate);
}
