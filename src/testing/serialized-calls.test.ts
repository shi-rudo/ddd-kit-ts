import { describe, expect, it } from "vite-plus/test";
import { serializedCalls } from "./serialized-calls";

describe("serializedCalls", () => {
	it("starts the second call only after the first call settled", async () => {
		const enqueue = serializedCalls();
		let releaseFirst!: () => void;
		const first = enqueue(
			() =>
				new Promise<void>((resolve) => {
					releaseFirst = resolve;
				}),
		);
		let secondStarted = false;
		const second = enqueue(async () => {
			secondStarted = true;
		});
		await Promise.resolve();

		expect(secondStarted).toBe(false);

		releaseFirst();
		await Promise.all([first, second]);

		expect(secondStarted).toBe(true);
	});

	it("keeps the value and the rejection of each call", async () => {
		const enqueue = serializedCalls();

		await expect(enqueue(async () => "loaded")).resolves.toBe("loaded");
		await expect(
			enqueue(() => Promise.reject(new Error("commit failed"))),
		).rejects.toThrow("commit failed");
	});

	it("runs the call after a rejected call", async () => {
		const enqueue = serializedCalls();
		const failed = enqueue(() => Promise.reject(new Error("commit failed")));

		const later = enqueue(async () => "still served");

		await expect(failed).rejects.toThrow("commit failed");
		await expect(later).resolves.toBe("still served");
	});
});
