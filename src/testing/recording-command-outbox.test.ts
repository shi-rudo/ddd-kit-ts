import { describe, expect, it } from "vite-plus/test";
import type { PublishedCommand } from "../application/cqrs/command/command";
import { recordingCommandOutbox } from "./recording-command-outbox";

describe("recordingCommandOutbox", () => {
	it("records every endEventSources in call order", async () => {
		const outbox = recordingCommandOutbox<PublishedCommand>();
		const source = { aggregateType: "Checkout", aggregateId: "c-1" };

		await outbox.add([]);
		await outbox.endEventSources([source]);

		expect(outbox.added).toEqual([[]]);
		expect(outbox.ended).toEqual([[source]]);
	});

	it("runs a replaced method in place of the recording", async () => {
		let calls = 0;
		const outbox = recordingCommandOutbox<PublishedCommand>({
			add: async () => {
				calls += 1;
			},
		});

		await outbox.add([]);

		expect(calls).toBe(1);
		expect(outbox.added).toEqual([]);
	});
});
