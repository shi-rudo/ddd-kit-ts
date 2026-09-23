import type { AggregateAddress } from "../../domain/aggregate/aggregate-address";
import { InvalidEventStreamPageError } from "../../errors/kit-errors";

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
