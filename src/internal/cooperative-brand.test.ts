import { describe, expect, it } from "vite-plus/test";
import {
	hasCooperativeBrand,
	stampCooperativeBrand,
} from "./cooperative-brand";

const BRAND = Symbol.for("@shirudo/ddd-kit/test-brand");

describe("cooperative brand", () => {
	it("recognizes a frozen carrier stamped by the kit", () => {
		const carrier = { type: "Fact" };
		stampCooperativeBrand(carrier, BRAND);
		Object.freeze(carrier);

		expect(hasCooperativeBrand(carrier, BRAND)).toBe(true);
	});

	it("keeps the brand out of spreads, keys, and JSON", () => {
		const carrier = { type: "Fact" };
		stampCooperativeBrand(carrier, BRAND);

		expect(Object.keys({ ...carrier })).toEqual(["type"]);
		expect(Object.getOwnPropertySymbols({ ...carrier })).toEqual([]);
		expect(JSON.stringify(carrier)).toBe('{"type":"Fact"}');
	});

	it("rejects a stamped carrier that is still open", () => {
		const carrier = { type: "Fact" };
		stampCooperativeBrand(carrier, BRAND);

		expect(hasCooperativeBrand(carrier, BRAND)).toBe(false);
	});

	it("rejects a carrier that inherits the brand through its prototype", () => {
		const branded = { type: "Fact" };
		stampCooperativeBrand(branded, BRAND);
		Object.freeze(branded);
		const heir = Object.freeze(Object.create(branded) as object);

		expect(hasCooperativeBrand(heir, BRAND)).toBe(false);
	});

	it("rejects a hand-rolled enumerable brand", () => {
		const carrier = Object.freeze({ type: "Fact", [BRAND]: true });

		expect(hasCooperativeBrand(carrier, BRAND)).toBe(false);
	});

	it("rejects a brand whose value is not true", () => {
		const carrier = Object.freeze(
			Object.defineProperty({ type: "Fact" }, BRAND, {
				value: 1,
				writable: false,
				configurable: false,
				enumerable: false,
			}),
		);

		expect(hasCooperativeBrand(carrier, BRAND)).toBe(false);
	});

	it("rejects primitives and nullish values", () => {
		expect(hasCooperativeBrand(null, BRAND)).toBe(false);
		expect(hasCooperativeBrand(undefined, BRAND)).toBe(false);
		expect(hasCooperativeBrand("Fact", BRAND)).toBe(false);
		expect(hasCooperativeBrand(42, BRAND)).toBe(false);
	});

	it("reads a Proxy whose descriptor trap throws as unbranded", () => {
		const hostile = new Proxy(
			{},
			{
				getOwnPropertyDescriptor: () => {
					throw new Error("trap");
				},
			},
		);

		expect(hasCooperativeBrand(hostile, BRAND)).toBe(false);
	});

	it("distinguishes brands by key", () => {
		const carrier = { type: "Fact" };
		stampCooperativeBrand(carrier, BRAND);
		Object.freeze(carrier);

		expect(
			hasCooperativeBrand(carrier, Symbol.for("@shirudo/ddd-kit/other-brand")),
		).toBe(false);
	});
});
