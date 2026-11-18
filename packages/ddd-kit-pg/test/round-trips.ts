import type { EventEmitter } from "node:events";
import type { ClientBase } from "pg";

/**
 * Counts the round trips of `client` from now on. PostgreSQL ends each round
 * trip with one ReadyForQuery.
 */
export function countRoundTrips(client: ClientBase): () => number {
	let roundTrips = 0;
	(client as unknown as { connection: EventEmitter }).connection.on(
		"readyForQuery",
		() => {
			roundTrips += 1;
		},
	);
	return () => roundTrips;
}
