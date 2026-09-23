import type { AggregateIdentity } from "../../domain/aggregate/aggregate-identity";
import { InvalidEventStreamPageError } from "../../errors/kit-errors";

export function assertValidHead(
	stream: AggregateIdentity,
	lastVersion: unknown,
	fromVersion: number,
	targetVersion?: number,
): asserts lastVersion is number {
	if (Number.isSafeInteger(lastVersion) && (lastVersion as number) >= 1) return;
	throw new InvalidEventStreamPageError({
		identity: stream,
		reason: "invalid_head",
		fromVersion,
		targetVersion,
		lastVersion,
	});
}

export function assertHeadNotBehindFirstPage(
	stream: AggregateIdentity,
	lastVersion: number,
	firstPageLastVersion: number,
	fromVersion: number,
	targetVersion: number,
): void {
	if (lastVersion >= firstPageLastVersion) return;
	throw new InvalidEventStreamPageError({
		identity: stream,
		reason: "head_regressed",
		fromVersion,
		targetVersion,
		lastVersion,
		firstPageLastVersion,
	});
}

export function assertPageNotEmpty(
	stream: AggregateIdentity,
	eventCount: number,
	fromVersion: number,
	targetVersion: number,
): void {
	if (eventCount > 0) return;
	throw new InvalidEventStreamPageError({
		identity: stream,
		reason: "empty_page",
		fromVersion,
		targetVersion,
	});
}

export function assertPageWithinWindow(
	stream: AggregateIdentity,
	eventCount: number,
	fromVersion: number,
	targetVersion: number,
): void {
	if (eventCount <= targetVersion - fromVersion) return;
	throw new InvalidEventStreamPageError({
		identity: stream,
		reason: "page_past_target",
		fromVersion,
		targetVersion,
		eventCount,
	});
}

export function assertPageWithinLimit(
	stream: AggregateIdentity,
	eventCount: number,
	limit: number,
	fromVersion: number,
	targetVersion: number,
): void {
	if (eventCount <= limit) return;
	throw new InvalidEventStreamPageError({
		identity: stream,
		reason: "page_over_limit",
		fromVersion,
		targetVersion,
		eventCount,
		limit,
	});
}
