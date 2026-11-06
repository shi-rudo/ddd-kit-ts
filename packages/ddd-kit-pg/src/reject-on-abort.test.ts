import { describe, expect, it } from "vite-plus/test";
import { rejectOnAbort } from "./reject-on-abort";

describe("rejectOnAbort", () => {
	it("rejects at once when the signal aborted before the call", async () => {
		const controller = new AbortController();
		controller.abort(new Error("the deadline passed"));

		await expect(
			rejectOnAbort(new Promise(() => {}), controller.signal),
		).rejects.toThrow("the deadline passed");
	});

	it("rejects when the signal aborts during the wait", async () => {
		const controller = new AbortController();
		const waiting = rejectOnAbort(new Promise(() => {}), controller.signal);

		controller.abort(new Error("the deadline passed"));

		await expect(waiting).rejects.toThrow("the deadline passed");
	});
});
