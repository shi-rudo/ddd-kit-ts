import { KitWiringError } from "../../errors/kit-errors";

/** Keeps a deep chain readable in the message without losing the recent path. */
const CHAIN_DISPLAY_LIMIT = 8;

function formatChain(eventTypeChain: readonly string[]): string {
	if (eventTypeChain.length <= CHAIN_DISPLAY_LIMIT) {
		return eventTypeChain.join(" -> ");
	}
	return `... -> ${eventTypeChain.slice(-CHAIN_DISPLAY_LIMIT).join(" -> ")}`;
}

/**
 * Thrown when one publish chain reaches `maxPublishDepth`.
 *
 * A handler that publishes re-enters `publish`, and JavaScript bounds nothing
 * here. A synchronous cycle overflows the call stack. An asynchronous cycle
 * starves the event loop until the process runs out of memory. The publish
 * timeout cannot stop either one, because a timer is a macrotask and a starved
 * loop never runs one.
 *
 * This is a wiring error, not an infrastructure failure. The handler graph
 * contains a cycle, or the nesting is deeper than the bus permits. A retry
 * repeats the fault, so `retryable` stays false, and a generic
 * `catch (error instanceof InfrastructureError)` cannot mask it.
 *
 * The guard follows the publish chain, never the bus instance. Concurrent
 * publications on one shared bus are correct usage and never reach it.
 */
export class PublishDepthExceededError extends KitWiringError<"PUBLISH_DEPTH_EXCEEDED"> {
	constructor(
		public readonly depth: number,
		public readonly maxPublishDepth: number,
		public readonly eventTypeChain: readonly string[],
	) {
		super(
			"PUBLISH_DEPTH_EXCEEDED",
			`EventBus.publish reached depth ${depth} of ${maxPublishDepth}: ` +
				`${formatChain(eventTypeChain)}. A handler publishes an event that ` +
				"leads back into the same chain. Break the cycle, or raise " +
				"maxPublishDepth when the nesting is intended.",
		);
	}
}
