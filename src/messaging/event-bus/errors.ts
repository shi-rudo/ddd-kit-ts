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

/**
 * Thrown when a closed bus is used.
 *
 * `close()` releases every subscription and settles every waiter, so the bus
 * holds nothing afterwards. A later `publish` would reach no handler and a
 * later `subscribe` would never fire, and both would look like a delivery
 * that simply did not happen.
 *
 * Use after close is a programming bug, usually a leaked reference or an
 * operation that outlived the scope that owned the bus, so this carries the
 * `WIRING` category and crashes loud rather than dropping the work in
 * silence.
 */
export class EventBusClosedError extends KitWiringError<"EVENT_BUS_CLOSED"> {
	constructor(public readonly operation: string) {
		super(
			"EVENT_BUS_CLOSED",
			`Event bus is closed: ${operation} was called after close(). ` +
				"Create one bus per scope and close it when that scope ends, " +
				"instead of holding a reference past it.",
		);
	}
}
