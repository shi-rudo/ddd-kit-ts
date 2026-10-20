import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A generator without the counter state that earlier tests left behind. */
async function freshGenerator(): Promise<() => string> {
	vi.resetModules();
	return (await import("./uuid-v7")).uuidV7;
}

function millisecondsOf(id: string): number {
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

describe("uuidV7", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("carries the version 7 and the RFC 9562 variant", async () => {
		const uuidV7 = await freshGenerator();
		const id = uuidV7();

		expect(id).toMatch(UUID_V7);
	});

	it("starts with the Unix time in milliseconds", async () => {
		const uuidV7 = await freshGenerator();
		const now = Date.UTC(2031, 4, 6, 7, 8, 9, 123);
		vi.spyOn(Date, "now").mockReturnValue(now);

		const id = uuidV7();

		expect(millisecondsOf(id)).toBe(now);
	});

	it("creates distinct ids that sort in creation order within one millisecond", async () => {
		const uuidV7 = await freshGenerator();
		vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2032, 0, 1));

		const ids = Array.from({ length: 1000 }, () => uuidV7());

		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(ids);
	});

	it("keeps the time field on the clock when one millisecond needs many ids", async () => {
		const uuidV7 = await freshGenerator();
		const now = Date.UTC(2033, 0, 1);
		vi.spyOn(Date, "now").mockReturnValue(now);

		const ids = Array.from({ length: 10_000 }, () => uuidV7());

		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(ids);
		expect(ids.every((id) => UUID_V7.test(id))).toBe(true);
		expect(ids.every((id) => millisecondsOf(id) === now)).toBe(true);
	});

	it("does not sort a later id first when the clock goes back", async () => {
		const uuidV7 = await freshGenerator();
		const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2034, 0, 1));
		const first = uuidV7();
		now.mockReturnValue(Date.UTC(2034, 0, 1) - 5_000);

		const second = uuidV7();

		expect(second > first).toBe(true);
		expect(millisecondsOf(second)).toBe(Date.UTC(2034, 0, 1));
	});
});
