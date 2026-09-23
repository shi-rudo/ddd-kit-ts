import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import { InvalidEventStreamPageError } from "../../errors/kit-errors";

export function assertValidHead(
	stream: AggregateAddress,
	lastVersion: unknown,
	fromVersion: number,
	targetVersion?: number,
): asserts lastVersion is number {
	if (Number.isSafeInteger(lastVersion) && (lastVersion as number) >= 1) return;
	throw new InvalidEventStreamPageError({
		...stream,
		reason: "invalid_head",
		fromVersion,
		targetVersion,
		lastVersion,
	});
}

export function assertHeadNotBehindFirstPage(
	stream: AggregateAddress,
	lastVersion: number,
	firstPageLastVersion: number,
	fromVersion: number,
	targetVersion: number,
): void {
	if (lastVersion >= firstPageLastVersion) return;
	throw new InvalidEventStreamPageError({
		...stream,
		reason: "head_regressed",
		fromVersion,
		targetVersion,
		lastVersion,
		firstPageLastVersion,
	});
}

export function assertPageNotEmpty(
	stream: AggregateAddress,
	eventCount: number,
	fromVersion: number,
	targetVersion: number,
): void {
	if (eventCount > 0) return;
	throw new InvalidEventStreamPageError({
		...stream,
		reason: "empty_page",
		fromVersion,
		targetVersion,
	});
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

export function assertPageWithinLimit(
	stream: AggregateAddress,
	eventCount: number,
	limit: number,
	fromVersion: number,
	targetVersion: number,
): void {
	if (eventCount <= limit) return;
	throw new InvalidEventStreamPageError({
		...stream,
		reason: "page_over_limit",
		fromVersion,
		targetVersion,
		eventCount,
		limit,
	});
}
