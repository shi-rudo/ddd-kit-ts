import { describe, expect, it } from "vite-plus/test";
import { encodeAggregateIdentity } from "./aggregate-identity";

describe("encodeAggregateIdentity", () => {
	it("keeps aggregate identities apart whose fields would collide under a naive join", () => {
		const shiftedType = encodeAggregateIdentity({
			aggregateType: "Order:1",
			aggregateId: "2",
		});
		const shiftedId = encodeAggregateIdentity({
			aggregateType: "Order",
			aggregateId: "1:2",
		});

		expect(shiftedType).not.toBe(shiftedId);
	});

	it("encodes equal aggregate identities to equal keys", () => {
		const first = encodeAggregateIdentity({
			aggregateType: "Order",
			aggregateId: "o-1",
		});
		const second = encodeAggregateIdentity({
			aggregateType: "Order",
			aggregateId: "o-1",
		});

		expect(first).toBe(second);
	});
});
