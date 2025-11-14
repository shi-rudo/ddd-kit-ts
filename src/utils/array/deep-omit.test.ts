// deep-omit.test.ts
import { describe, expect, it } from "vitest";
import { deepOmit } from "./deep-omit";

describe("deepOmit – Primitives and Functions", () => {
	it("leaves primitives unchanged", () => {
		expect(deepOmit(1, {})).toBe(1);
		expect(deepOmit("foo", {})).toBe("foo");
		expect(deepOmit(true, {})).toBe(true);
		expect(deepOmit(null, {})).toBe(null);
		expect(deepOmit(undefined, {})).toBe(undefined);
	});

	it("leaves functions unchanged", () => {
		const fn = () => 123;
		expect(deepOmit(fn, {})).toBe(fn);
	});
});

describe("deepOmit – Simple Objects", () => {
	it("removes keys from ignoreKeys at top level", () => {
		const input = { id: 1, name: "Alice", updatedAt: "2024-01-01" };
		const result = deepOmit(input, { ignoreKeys: ["id", "updatedAt"] });

		expect(result).toEqual({ name: "Alice" });
		expect(input).toEqual({
			id: 1,
			name: "Alice",
			updatedAt: "2024-01-01",
		}); // no mutation
	});

	it("leaves unlisted keys unchanged", () => {
		const input = { a: 1, b: 2 };
		const result = deepOmit(input, { ignoreKeys: ["x"] });

		expect(result).toEqual({ a: 1, b: 2 });
	});
});

describe("deepOmit – Nested Objects and Arrays", () => {
	it("removes keys recursively in nested structure", () => {
		const input = {
			id: 1,
			user: {
				id: 2,
				name: "Bob",
				posts: [
					{ id: 10, title: "A" },
					{ id: 11, title: "B" },
				],
			},
		};

		const result = deepOmit(input, { ignoreKeys: ["id"] });

		expect(result).toEqual({
			user: {
				name: "Bob",
				posts: [{ title: "A" }, { title: "B" }],
			},
		});
	});

	it("removes keys in arrays of objects", () => {
		const input = [
			{ id: 1, value: "x" },
			{ id: 2, value: "y" },
		];

		const result = deepOmit(input, { ignoreKeys: ["id"] });

		expect(result).toEqual([{ value: "x" }, { value: "y" }]);
	});

	it("does not mutate the original object", () => {
		const input = {
			meta: { id: 1, version: 2 },
			items: [{ id: 3 }, { id: 4 }],
		};

		const copy = structuredClone(input);
		const result = deepOmit(input, { ignoreKeys: ["id"] });

		expect(input).toEqual(copy);
		expect(result).not.toBe(input);
		expect(result.meta).not.toBe(input.meta);
		expect(result.items).not.toBe(input.items);
	});
});

describe("deepOmit – ignoreKeyPredicate with Path", () => {
	it("removes only keys matched by the predicate", () => {
		const input = {
			meta: { updatedAt: "2024-01-01", version: 1 },
			data: { updatedAt: "X", value: 42 },
		};

		const result = deepOmit(input, {
			ignoreKeyPredicate: (key, path) =>
				key === "updatedAt" && path[path.length - 1] === "meta",
		});

		expect(result).toEqual({
			meta: { version: 1 },
			data: { updatedAt: "X", value: 42 },
		});
	});

	it("combines ignoreKeys and ignoreKeyPredicate", () => {
		const input = {
			id: 1,
			meta: { updatedAt: "2024-01-01", version: 1 },
			data: { updatedAt: "X" },
		};

		const result = deepOmit(input, {
			ignoreKeys: ["id"],
			ignoreKeyPredicate: (key, path) =>
				key === "updatedAt" && path[path.length - 1] === "meta",
		});

		expect(result).toEqual({
			meta: { version: 1 },
			data: { updatedAt: "X" },
		});
	});
});

describe("deepOmit – Object.create(null) and Symbols", () => {
	it("supports Object.create(null)", () => {
		const obj = Object.create(null) as any;
		obj.id = 1;
		obj.name = "NullProto";

		const result = deepOmit(obj, { ignoreKeys: ["id"] }) as any;

		expect(result.id).toBeUndefined();
		expect(result.name).toBe("NullProto");
	});

	it("removes Symbol keys", () => {
		const symA = Symbol("a");
		const symB = Symbol("b");

		const input = {
			[symA]: 1,
			[symB]: 2,
			value: 3,
		};

		const result = deepOmit(input, { ignoreKeys: [symA] });

		expect(Object.getOwnPropertySymbols(result)).toEqual([symB]);
		expect((result as any)[symB]).toBe(2);
		expect((result as any).value).toBe(3);
	});
});

describe("deepOmit – Built-ins Atomic", () => {
	it("leaves Date instances unchanged and identical", () => {
		const date = new Date("2024-01-01T00:00:00Z");
		const input = { id: 1, date };

		const result = deepOmit(input, { ignoreKeys: ["id"] });

		expect(result).toEqual({ date });
		expect((result as any).date).toBe(date); // same reference
	});

	it("leaves RegExp instances unchanged", () => {
		const re = /abc/gi;
		const input = { pattern: re };
		const result = deepOmit(input, { ignoreKeys: ["x"] });

		expect((result as any).pattern).toBe(re);
	});

	it("treats Map atomically (no internal changes)", () => {
		const map = new Map<string, any>([
			["id", 1],
			["value", "x"],
		]);
		const input = { map };

		const result = deepOmit(input, { ignoreKeys: ["id"] });

		// map content remains untouched
		expect((result as any).map).toBe(map);
		expect(map.has("id")).toBe(true);
		expect(map.get("value")).toBe("x");
	});

	it("treats Set atomically", () => {
		const set = new Set<any>([{ id: 1 }, { id: 2 }]);
		const input = { set };

		const result = deepOmit(input, { ignoreKeys: ["id"] });

		expect((result as any).set).toBe(set);
		expect(set.size).toBe(2);
	});

	it("treats Typed Arrays atomically", () => {
		const arr = new Uint8Array([1, 2, 3]);
		const input = { buffer: arr };

		const result = deepOmit(input, { ignoreKeys: ["buffer2"] });

		expect((result as any).buffer).toBe(arr);
	});

	it("treats DataView atomically", () => {
		const buf = new ArrayBuffer(4);
		const view = new DataView(buf);
		view.setUint8(0, 42);

		const input = { view, meta: { id: 1 } };
		const result = deepOmit(input, { ignoreKeys: ["id"] });

		expect((result as any).view).toBe(view);
		expect((result as any).meta).toEqual({});
	});
});

describe("deepOmit – Circular References", () => {
	it("does not break on self-references", () => {
		const a: any = { id: 1, value: "x" };
		a.self = a;

		const result = deepOmit(a, { ignoreKeys: ["id"] }) as any;

		expect(result.value).toBe("x");
		expect(result.self).toBe(result); // cycle is preserved
		expect("id" in result).toBe(false);
	});

	it("handles nested cycles", () => {
		const a: any = { name: "root" };
		const child: any = { parent: a, secret: 123 };
		a.child = child;
		a.ref = a;

		const result = deepOmit(a, { ignoreKeys: ["secret"] }) as any;

		expect(result.name).toBe("root");
		expect(result.child.parent).toBe(result);
		expect(result.ref).toBe(result);
		expect("secret" in result.child).toBe(false);
	});
});
