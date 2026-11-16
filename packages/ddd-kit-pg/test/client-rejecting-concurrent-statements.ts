import { Client } from "pg";

/**
 * A `pg` client that rejects a statement while another statement of it runs.
 * pg 8 queues such a statement and warns that pg 9 removes the queue. With this
 * client, a test fails on pg 8 where it would fail on pg 9.
 */
export class ClientRejectingConcurrentStatements extends Client {
	#statementRunning = false;

	// biome-ignore lint/suspicious/noExplicitAny: the override covers every overload of query.
	override query(...args: any[]): any {
		const callback = args.at(-1);
		if (this.#statementRunning) {
			const failure = new Error(
				"ClientRejectingConcurrentStatements: a statement started while another statement of the client ran",
			);
			if (typeof callback !== "function") return Promise.reject(failure);
			queueMicrotask(() => callback(failure));
			return undefined;
		}
		this.#statementRunning = true;
		if (typeof callback === "function") {
			args[args.length - 1] = (...results: unknown[]) => {
				this.#statementRunning = false;
				callback(...results);
			};
			return Reflect.apply(super.query, this, args);
		}
		return Reflect.apply(super.query, this, args).finally(() => {
			this.#statementRunning = false;
		});
	}
}
