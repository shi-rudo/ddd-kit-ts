import { Client } from "pg";

/**
 * A `pg` client that rejects a statement while another statement of it runs.
 * pg 8 queues such a statement and deprecates that. The client frees itself
 * when pg reports the result, which for an error is before the connection is
 * ready again. It supports the promise form and the callback form of `query`.
 */
export class ClientRejectingConcurrentStatements extends Client {
	#statementRunning = false;

	// biome-ignore lint/suspicious/noExplicitAny: the override covers every overload of query.
	override query(...args: any[]): any {
		const [config] = args;
		if (
			typeof config?.submit === "function" ||
			typeof config?.callback === "function"
		) {
			throw new TypeError(
				"ClientRejectingConcurrentStatements: use the promise form or the callback form of query",
			);
		}
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
		}
		let result: unknown;
		try {
			result = Reflect.apply(super.query, this, args);
		} catch (failure) {
			this.#statementRunning = false;
			throw failure;
		}
		if (typeof callback === "function") return result;
		return (result as Promise<unknown>).finally(() => {
			this.#statementRunning = false;
		});
	}
}
