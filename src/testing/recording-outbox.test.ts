import { describe, expect, it } from "vite-plus/test";
import {
	createDomainEvent,
	type DomainEvent,
} from "../domain/event/domain-event";
import type { EventCommitCandidate } from "../messaging/committed-event";
import { recordingOutbox } from "./recording-outbox";

type OrderPlaced = DomainEvent<"OrderPlaced", { orderId: string }>;

const source = { aggregateType: "Order", aggregateId: "o-1" };

function placed(): EventCommitCandidate<OrderPlaced> {
	return {
		event: createDomainEvent("OrderPlaced", { orderId: "o-1" }, source),
		source,
		position: { aggregateVersion: 1, commitSequence: 0, commitSize: 1 },
	};
}

describe("recordingOutbox", () => {
	it("records every add and every endEventSources in call order", async () => {
		const outbox = recordingOutbox<OrderPlaced>();
		const candidate = placed();

		await outbox.add([candidate]);
		await outbox.endEventSources([source]);

		expect(outbox.added).toEqual([[candidate]]);
		expect(outbox.ended).toEqual([[source]]);
		expect(await outbox.getPending()).toEqual([]);
	});

	it("runs a replaced method in place of the recording", async () => {
		const failure = new Error("outbox unavailable");
		const outbox = recordingOutbox<OrderPlaced>({
			add: async () => {
				throw failure;
			},
		});

		await expect(outbox.add([placed()])).rejects.toBe(failure);
		expect(outbox.added).toEqual([]);
	});
});
