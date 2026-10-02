import { describe, expect, it } from "vite-plus/test";
import { abortReason, waitRejectingOnAbort } from "./abort";

describe("abortReason", () => {
	it("returns the signal's reason when it is set", () => {
		const ac = new AbortController();
		const reason = new Error("client gave up");
		ac.abort(reason);

		expect(abortReason(ac.signal, "fallback")).toBe(reason);
	});

	it("returns the AbortSignal.timeout reason (a TimeoutError) when set", () => {
		const signal = AbortSignal.timeout(0);
		// Give the timeout a tick to fire.
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				const r = abortReason(signal, "fallback");
				expect(r).toBeInstanceOf(Error); // DOMException is an Error subtype
				expect(r).not.toBe("fallback");
				resolve();
			}, 5);
		});
	});

	it("falls back to a real Error when reason is undefined (non-spec polyfill)", () => {
		const polyfillSignal = { aborted: true, reason: undefined } as AbortSignal;
		const r = abortReason(polyfillSignal, "the fallback message");
		expect(r).toBeInstanceOf(Error);
		expect((r as Error).message).toBe("the fallback message");
	});
});

describe("waitRejectingOnAbort", () => {
	it("resolves with the value of the promise", async () => {
		const controller = new AbortController();

		await expect(
			waitRejectingOnAbort(Promise.resolve("done"), controller.signal, "x"),
		).resolves.toBe("done");
	});

	it("rejects with the abort reason while the promise still runs", async () => {
		const controller = new AbortController();
		const reason = new Error("caller gave up");
		const waiting = waitRejectingOnAbort(
			new Promise<never>(() => {}),
			controller.signal,
			"x",
		);

		controller.abort(reason);

		await expect(waiting).rejects.toBe(reason);
	});

	it("rejects at once when the signal is already aborted", async () => {
		const controller = new AbortController();
		const reason = new Error("caller gave up");
		controller.abort(reason);

		await expect(
			waitRejectingOnAbort(Promise.resolve("done"), controller.signal, "x"),
		).rejects.toBe(reason);
	});
});
