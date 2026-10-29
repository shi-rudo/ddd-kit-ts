import { describe, expect, it } from "vite-plus/test";
import { assertJsonValue } from "./json-value";

/** A value with `levels` levels of nested records: 1 level is `{}`. */
function nestedRecords(levels: number): Record<string, unknown> {
	let value: Record<string, unknown> = {};
	for (let level = 1; level < levels; level += 1) value = { child: value };
	return value;
}

/** A value with `levels` levels of nested arrays: 1 level is `[]`. */
function nestedArrays(levels: number): unknown[] {
	let value: unknown[] = [];
	for (let level = 1; level < levels; level += 1) value = [value];
	return value;
}

class InvalidJson extends Error {
	constructor(readonly path: string) {
		super(path);
	}
}

const invalid = (path: string): never => {
	throw new InvalidJson(path);
};

describe("assertJsonValue nesting", () => {
	it("accepts 100 levels of nesting", () => {
		expect(() =>
			assertJsonValue(nestedRecords(100), "$", invalid),
		).not.toThrow();
		expect(() =>
			assertJsonValue(nestedArrays(100), "$", invalid),
		).not.toThrow();
	});

	it("reports a 101st level to the boundary, also where a recursive walk would overflow the stack", () => {
		expect(() => assertJsonValue(nestedRecords(101), "$", invalid)).toThrow(
			InvalidJson,
		);
		expect(() => assertJsonValue(nestedArrays(5000), "$", invalid)).toThrow(
			InvalidJson,
		);
	});
});
