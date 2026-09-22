import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../../domain/event/domain-event";
import { InvalidEventStreamPageError } from "../../errors/kit-errors";
import {
	assertNonNegativeSafeInteger,
	assertPositiveSafeInteger,
} from "../../internal/validate";
import type { EventStreamReader, ReadStreamOptions } from "./event-store";
import {
	assertPageWithinWindow,
	type ReplayableStreamPages,
} from "./reconstitute-from-stream-pages";

/** Options for {@link readStreamPages}. */
export interface ReadStreamPagesOptions
	extends Pick<ReadStreamOptions, "limit" | "fromVersion" | "signal"> {
	/**
	 * The version a point-in-time read asks for (inclusive, 1-based event
	 * count). Without it, the target version is the head that the first page
	 * reports. A value beyond the head does not clamp: see
	 * {@link pinTargetVersion}. Must be a positive safe integer when present.
	 * Version 0 is the state before the first event, and no replay can end
	 * there.
	 */
	readonly toVersion?: number;
}

/**
 * A stream read with the target version pinned on its first page.
 *
 * The first page decides the state of the stream once, in three branches.
 * An absent stream is `exists: false`. An existing stream whose window lies
 * outside it is `reachable: false` and carries the actual head. The
 * remaining branch carries the target version and the pages after the
 * cursor. The other two branches both carry `reachable: false`, so one
 * guard narrows to the branch that
 * {@link reconstituteAggregateFromStreamPages} accepts. The caller decides
 * what the other two branches mean before the replay.
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
 * existing stream: the cursor lies beyond the target version, or the
 * target version lies beyond the head ({@link pinTargetVersion}).
 *
 * The caller tells the causes apart from its own inputs. A snapshot
 * version above `lastVersion` means that the snapshot outlived its stream:
 * discard it and replay from zero. A `toVersion` above `lastVersion` means
 * that the stream has not reached that version: answer not found and keep
 * the snapshot. A snapshot version above `toVersion` means that the
 * snapshot is too new for the request: keep it and replay from zero up to
 * `toVersion`.
 */
export interface UnreachableStreamPages {
	readonly exists: true;
	readonly reachable: false;

	/** The cursor the read started at: `fromVersion`, or `0`. */
	readonly fromVersion: number;

	/** The actual stream head on the first page. */
	readonly lastVersion: number;
}

/** The branch of {@link StreamPages} that the replay accepts. */
export interface ReachableStreamPages<Evt extends AnyDomainEvent>
	extends ReplayableStreamPages<Evt> {
	readonly exists: true;
	readonly reachable: true;
}

/** Options for {@link pinTargetVersion}. */
export interface PinTargetVersionOptions {
	/** The cursor of the read: the replay starts after this version. */
	readonly fromVersion: number;

	/** The version a point-in-time read asks for. Defaults to `lastVersion`. */
	readonly toVersion?: number;

	/** The head of the existing stream: its event count. */
	readonly lastVersion: number;
}

/** The verdict of {@link pinTargetVersion}. */
export type PinnedTargetVersion =
	| { readonly reachable: true; readonly targetVersion: number }
	| { readonly reachable: false };

/**
 * Pins the target version of a replay window on an existing stream, or
 * reports the window as unreachable.
 *
 * The target version is `toVersion` when given, else `lastVersion`. The
 * window is unreachable when `fromVersion` lies beyond the target version,
 * or the target version lies beyond `lastVersion`. The call never clamps
 * such a window to the head, so a request for version 10 of a stream that
 * ends at 7 never loads the latest state by accident.
 *
 * This is the decision `readStreamPages` makes on its first page. An
 * adapter that pages on its own makes it with this call, then hands its
 * pages to `reconstituteAggregateFromStreamPages`. Values that are not safe
 * integers, a negative `fromVersion`, and a `toVersion` or `lastVersion`
 * below 1 reject with `RangeError`: an existing stream holds at least one
 * event, and no replay can end at version 0.
 */
export function pinTargetVersion(
	options: PinTargetVersionOptions,
): PinnedTargetVersion {
	assertNonNegativeSafeInteger(
		"pinTargetVersion",
		"fromVersion",
		options.fromVersion,
	);
	if (options.toVersion !== undefined) {
		assertPositiveSafeInteger(
			"pinTargetVersion",
			"toVersion",
			options.toVersion,
		);
	}
	assertPositiveSafeInteger(
		"pinTargetVersion",
		"lastVersion",
		options.lastVersion,
	);
	const targetVersion = options.toVersion ?? options.lastVersion;
	if (
		options.fromVersion > targetVersion ||
		targetVersion > options.lastVersion
	) {
		return { reachable: false };
	}
	return { reachable: true, targetVersion };
}

/**
 * Reads one stream in bounded pages up to a pinned target version.
 *
 * The call reads the first page. That page decides existence and reports
 * the head. {@link pinTargetVersion} then decides the window: the target
 * version is `toVersion` when given, else the head, and a window outside
 * the stream is unreachable.
 *
 * The call keeps the first page in memory. Every iteration of `pages`
 * yields that page again and reads the continuation pages from the store
 * again, one page at a time. Each continuation read passes the target
 * version as `toVersion` and starts after the events that the earlier pages
 * returned. Streams are append-only, so an iteration yields one stable
 * prefix even when another writer appends during the replay.
 *
 * The call checks every page against the `readStream` contract and throws
 * {@link InvalidEventStreamPageError} for a page that breaks it: an
 * existing stream with a head below 1, a page with more events than its
 * window has left, and a continuation page that is empty, reports the
 * stream absent, or reports a head below the head of the first page.
 *
 * Invalid options reject with `RangeError` before any page is read:
 * `limit` and `toVersion` must be positive safe integers, `fromVersion` a
 * non-negative one. The call passes `signal` to every page read, and it
 * checks the signal before each page read as well. An aborted signal
 * rejects with its `reason`.
 */
export async function readStreamPages<Evt extends AnyDomainEvent>(
	reader: EventStreamReader<Evt>,
	stream: AggregateAddress,
	options: ReadStreamPagesOptions,
): Promise<StreamPages<Evt>> {
	assertPositiveSafeInteger("readStreamPages", "limit", options.limit);
	const fromVersion = options.fromVersion ?? 0;
	assertNonNegativeSafeInteger("readStreamPages", "fromVersion", fromVersion);
	if (options.toVersion !== undefined) {
		assertPositiveSafeInteger(
			"readStreamPages",
			"toVersion",
			options.toVersion,
		);
	}
	throwIfAborted(options.signal);
	const address: AggregateAddress = {
		aggregateType: stream.aggregateType,
		aggregateId: stream.aggregateId,
	};
	const first = await reader.readStream(address, {
		fromVersion,
		limit: options.limit,
		...(options.toVersion === undefined
			? {}
			: { toVersion: options.toVersion }),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	if (!first.exists) return { exists: false, reachable: false };
	if (first.lastVersion < 1) {
		throw new InvalidEventStreamPageError({
			...address,
			reason: "stream_without_events",
			fromVersion,
			lastVersion: first.lastVersion,
		});
	}
	const pinned = pinTargetVersion({
		fromVersion,
		toVersion: options.toVersion,
		lastVersion: first.lastVersion,
	});
	if (!pinned.reachable) {
		return {
			exists: true,
			reachable: false,
			fromVersion,
			lastVersion: first.lastVersion,
		};
	}
	assertPageWithinWindow(
		address,
		first.events.length,
		fromVersion,
		pinned.targetVersion,
	);
	const window: PinnedWindow<Evt> = {
		stream: address,
		firstPage: first.events,
		firstPageLastVersion: first.lastVersion,
		cursorAfterFirstPage: fromVersion + first.events.length,
		targetVersion: pinned.targetVersion,
		limit: options.limit,
		signal: options.signal,
	};
	return {
		exists: true,
		reachable: true,
		stream: address,
		fromVersion,
		targetVersion: pinned.targetVersion,
		pages: {
			[Symbol.asyncIterator]: () => continueToPinnedTarget(reader, window),
		},
	};
}

interface PinnedWindow<Evt extends AnyDomainEvent> {
	readonly stream: AggregateAddress;
	readonly firstPage: ReadonlyArray<Evt>;
	readonly firstPageLastVersion: number;
	readonly cursorAfterFirstPage: number;
	readonly targetVersion: number;
	readonly limit: number;
	readonly signal: AbortSignal | undefined;
}

async function* continueToPinnedTarget<Evt extends AnyDomainEvent>(
	reader: EventStreamReader<Evt>,
	window: PinnedWindow<Evt>,
): AsyncGenerator<ReadonlyArray<Evt>, void, undefined> {
	if (window.firstPage.length > 0) yield window.firstPage;
	let cursor = window.cursorAfterFirstPage;
	while (cursor < window.targetVersion) {
		throwIfAborted(window.signal);
		const page = await reader.readStream(window.stream, {
			fromVersion: cursor,
			toVersion: window.targetVersion,
			limit: window.limit,
			...(window.signal === undefined ? {} : { signal: window.signal }),
		});
		const pageAt = {
			...window.stream,
			fromVersion: cursor,
			targetVersion: window.targetVersion,
		};
		if (!page.exists) {
			throw new InvalidEventStreamPageError({
				...pageAt,
				reason: "stream_vanished",
			});
		}
		if (page.lastVersion < window.firstPageLastVersion) {
			throw new InvalidEventStreamPageError({
				...pageAt,
				reason: "head_regressed",
				lastVersion: page.lastVersion,
				firstPageLastVersion: window.firstPageLastVersion,
			});
		}
		if (page.events.length === 0) {
			throw new InvalidEventStreamPageError({
				...pageAt,
				reason: "empty_page",
			});
		}
		assertPageWithinWindow(
			window.stream,
			page.events.length,
			cursor,
			window.targetVersion,
		);
		yield page.events;
		cursor += page.events.length;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason;
}
