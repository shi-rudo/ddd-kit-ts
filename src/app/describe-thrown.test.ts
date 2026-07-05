import { describe, expect, it } from "vitest";
import { describeThrown } from "./describe-thrown";

describe("describeThrown()", () => {
	it("renders an Error via its message", () => {
		expect(describeThrown(new Error("boom"))).toBe("boom");
	});

	it("JSON-serialises structured objects so fields stay readable", () => {
		expect(describeThrown({ code: "DB_CONN" })).toBe('{"code":"DB_CONN"}');
	});

	it("falls back to String() for values JSON cannot represent", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(describeThrown(cyclic)).toBe("[object Object]");
	});

	it("is total for a cyclic null-prototype object, where String() throws too", () => {
		// JSON.stringify throws on the cycle, then String() throws on the
		// missing Object.prototype.toString; the default bus mapper must
		// still produce a string instead of crashing the dispatch.
		const evil = Object.create(null) as { self?: unknown };
		evil.self = evil;

		expect(typeof describeThrown(evil)).toBe("string");
	});

	it("is total for a revoked Proxy, where even instanceof throws", () => {
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();

		expect(typeof describeThrown(proxy)).toBe("string");
	});

	it("is total for an Error subclass whose message getter throws", () => {
		class HostileMessageError extends Error {
			// biome-ignore lint/complexity/noUselessConstructor: no super message, so the prototype getter below is reachable
			constructor() {
				super();
			}
			override get message(): string {
				throw new Error("gotcha");
			}
		}

		expect(typeof describeThrown(new HostileMessageError())).toBe("string");
	});
});
