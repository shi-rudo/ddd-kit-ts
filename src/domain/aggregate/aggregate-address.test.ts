import { describe, expect, it } from "vite-plus/test";
import { encodeAggregateAddress } from "./aggregate-address";

describe("encodeAggregateAddress", () => {
	it("keeps addresses apart whose fields would collide under a naive join", () => {
		const shiftedType = encodeAggregateAddress({
			aggregateType: "Order:1",
			aggregateId: "2",
		});
		const shiftedId = encodeAggregateAddress({
			aggregateType: "Order",
			aggregateId: "1:2",
		});

		expect(shiftedType).not.toBe(shiftedId);
	});

	it("encodes equal addresses to equal keys", () => {
		const first = encodeAggregateAddress({
			aggregateType: "Order",
			aggregateId: "o-1",
		});
		const second = encodeAggregateAddress({
			aggregateType: "Order",
			aggregateId: "o-1",
		});

		expect(first).toBe(second);
	});
});
