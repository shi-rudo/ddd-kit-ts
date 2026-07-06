import { describe, expect, it } from "vitest";
import { deepEqual } from "./deep-equal";
import { deepEqualExcept } from "./deep-equal-except";

describe("deepEqualExcept – Basic Behavior", () => {
	it("behaves like deepEqual without ignore rules", () => {
		const a = { x: 1, y: [1, 2, 3] };
		const b = { x: 1, y: [1, 2, 3] };
		const c = { x: 2, y: [1, 2, 3] };

		expect(deepEqualExcept(a, b, {})).toBe(true);
		expect(deepEqualExcept(a, c, {})).toBe(false);

		// Consistency with deepEqual
		expect(deepEqualExcept(a, b, {})).toBe(deepEqual(a, b));
		expect(deepEqualExcept(a, c, {})).toBe(deepEqual(a, c));
	});

	it("works with primitives", () => {
		expect(deepEqualExcept(1, 1, {})).toBe(true);
		expect(deepEqualExcept(1, 2, {})).toBe(false);
		expect(deepEqualExcept("a", "a", {})).toBe(true);
		expect(deepEqualExcept("a", "b", {})).toBe(false);
		expect(deepEqualExcept(NaN, NaN, {})).toBe(true);
	});
});

describe("deepEqualExcept – ignoreKeys", () => {
	it("ignores global keys everywhere in the object tree", () => {
		const a = {
			id: 1,
			name: "Alice",
			meta: {
				updatedAt: "2024-01-01",
				version: 1,
			},
			items: [
				{ id: 10, value: "x" },
				{ id: 11, value: "y" },
			],
		};

		const b = {
			id: 2,
			name: "Alice",
			meta: {
				updatedAt: "2024-02-01",
				version: 1,
			},
			items: [
				{ id: 99, value: "x" },
				{ id: 100, value: "y" },
			],
		};

		// Differences only in id / updatedAt → equal when ignored
		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: ["id", "updatedAt"],
			}),
		).toBe(true);
	});

	it("reports differences in non-ignored keys correctly", () => {
		const a = { id: 1, name: "Alice" };
		const b = { id: 2, name: "Bob" };

		// ignore id, not name
		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: ["id"],
			}),
		).toBe(false);
	});

	it("works with arrays of objects", () => {
		const a = [
			{ id: 1, value: "x" },
			{ id: 2, value: "y" },
		];
		const b = [
			{ id: 10, value: "x" },
			{ id: 11, value: "y" },
		];

		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: ["id"],
			}),
		).toBe(true);
	});

	it("preserves array symbol and custom-property differences unless ignored", () => {
		const metadata = Symbol("metadata");
		const a = Object.assign([1], { label: "a", [metadata]: "a" });
		const b = Object.assign([1], { label: "b", [metadata]: "b" });

		expect(deepEqualExcept(a, b, { ignoreKeys: ["unrelated"] })).toBe(false);
		expect(deepEqualExcept(a, b, { ignoreKeys: ["label", metadata] })).toBe(
			true,
		);
	});

	it("preserves the difference between sparse holes and explicit undefined", () => {
		expect(
			deepEqualExcept(new Array(1), [undefined], {
				ignoreKeys: ["unrelated"],
			}),
		).toBe(false);
	});
});

describe("deepEqualExcept – ignoreKeyPredicate", () => {
	it("ignores keys only at specific paths", () => {
		const a = {
			meta: { updatedAt: "2024-01-01", version: 1 },
			data: { updatedAt: "X", value: 42 },
		};

		const b = {
			meta: { updatedAt: "2024-02-01", version: 1 },
			data: { updatedAt: "Y", value: 42 },
		};

		// ignore meta.updatedAt, not data.updatedAt
		const equal = deepEqualExcept(a, b, {
			ignoreKeyPredicate: (key, path) =>
				key === "updatedAt" && path[path.length - 1] === "meta",
		});

		expect(equal).toBe(false); // data.updatedAt differs
	});

	it("combines ignoreKeys and ignoreKeyPredicate", () => {
		const a = {
			id: 1,
			meta: { updatedAt: "2024-01-01", version: 1 },
			data: { updatedAt: "X", value: 42 },
		};

		const b = {
			id: 2,
			meta: { updatedAt: "2024-02-01", version: 1 },
			data: { updatedAt: "Y", value: 42 },
		};

		const equal = deepEqualExcept(a, b, {
			ignoreKeys: ["id"],
			ignoreKeyPredicate: (key, path) =>
				key === "updatedAt" && path[path.length - 1] === "meta",
		});

		// id ignored, meta.updatedAt ignored, data.updatedAt differs
		expect(equal).toBe(false);

		const equalWithoutDataDiff = deepEqualExcept(
			{
				...a,
				data: { updatedAt: "Y", value: 42 },
			},
			b,
			{
				ignoreKeys: ["id"],
				ignoreKeyPredicate: (key, path) =>
					key === "updatedAt" && path[path.length - 1] === "meta",
			},
		);

		expect(equalWithoutDataDiff).toBe(true);
	});
});

describe("deepEqualExcept – Symbols & Object.create(null)", () => {
	it("ignores symbol keys when specified in ignoreKeys", () => {
		const symA = Symbol("a");
		const symB = Symbol("b");

		const a = {
			[symA]: 1,
			[symB]: 2,
			value: 3,
		};
		const b = {
			[symA]: 999,
			[symB]: 2,
			value: 3,
		};

		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: [symA],
			}),
		).toBe(true);

		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: [symB],
			}),
		).toBe(false);
	});

	it("works with Object.create(null)", () => {
		const a = Object.create(null) as any;
		const b = Object.create(null) as any;

		a.id = 1;
		a.name = "NullProto";

		b.id = 999;
		b.name = "NullProto";

		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: ["id"],
			}),
		).toBe(true);

		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: [],
			}),
		).toBe(false);
	});
});

describe("deepEqualExcept – Built-ins & Interaction with deepEqual", () => {
	it("ignores object keys, but treats Date/RegExp atomically", () => {
		const date1 = new Date("2024-01-01T00:00:00Z");
		const date2 = new Date("2024-01-02T00:00:00Z");

		const a = { id: 1, date: date1 };
		const b = { id: 2, date: date2 };

		// ignore id, Date remains relevant → unequal
		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: ["id"],
			}),
		).toBe(false);

		// truly identical Date values → equal
		const c = { id: 2, date: new Date("2024-01-01T00:00:00Z") };
		expect(
			deepEqualExcept(a, c, {
				ignoreKeys: ["id"],
			}),
		).toBe(true);
	});

	it("does not modify Map/Set contents and respects deep comparison", () => {
		const mapA = new Map<string, any>([
			["id", 1],
			["data", { x: 1 }],
		]);
		const mapB = new Map<string, any>([
			["id", 99],
			["data", { x: 1 }],
		]);

		const a = { meta: { updatedAt: "2024-01-01" }, map: mapA };
		const b = { meta: { updatedAt: "2024-02-01" }, map: mapB };

		// Ignores id in object, but Map content remains unchanged → deepEqual decides
		const equal = deepEqualExcept(a, b, {
			ignoreKeys: ["updatedAt"],
		});

		// mapA and mapB differ (key "id" in the Map), so false
		expect(equal).toBe(false);
	});
});

describe("deepEqualExcept – Reference-compared built-ins (Promise, WeakMap, WeakSet, Error, ArrayBuffer)", () => {
	it("is reflexive for an object containing a Promise", () => {
		const obj = { p: Promise.resolve(1), name: "job" };
		expect(deepEqualExcept(obj, obj, { ignoreKeys: [] })).toBe(true);
	});

	it("compares shared Promise references as equal across two objects", () => {
		const p = Promise.resolve(1);
		const a = { p, id: 1 };
		const b = { p, id: 2 };
		expect(deepEqualExcept(a, b, { ignoreKeys: ["id"] })).toBe(true);
	});

	it("is reflexive for objects containing WeakMap and WeakSet", () => {
		const obj = { wm: new WeakMap(), ws: new WeakSet() };
		expect(deepEqualExcept(obj, obj, { ignoreKeys: [] })).toBe(true);
	});

	it("is reflexive for an object containing an ArrayBuffer", () => {
		const obj = { buf: new ArrayBuffer(4), name: "blob" };
		expect(deepEqualExcept(obj, obj, { ignoreKeys: [] })).toBe(true);
	});

	it("is reflexive for an object containing an Error", () => {
		const obj = { e: new Error("oops"), name: "job" };
		expect(deepEqualExcept(obj, obj, { ignoreKeys: [] })).toBe(true);
	});

	it("compares shared Error/ArrayBuffer references as equal across two objects", () => {
		const e = new Error("oops");
		const buf = new ArrayBuffer(4);
		const a = { e, buf, id: 1 };
		const b = { e, buf, id: 2 };
		expect(deepEqualExcept(a, b, { ignoreKeys: ["id"] })).toBe(true);
	});
});

describe("deepEqualExcept – Circular References", () => {
	it("works with cycles when only ignored keys differ", () => {
		const a: any = { id: 1, value: "x" };
		a.self = a;

		const b: any = { id: 2, value: "x" };
		b.self = b;

		// Only id differs → ignored → equal
		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: ["id"],
			}),
		).toBe(true);
	});

	it("detects differences in non-ignored fields despite cycles", () => {
		const a: any = { id: 1, value: "x" };
		a.self = a;

		const b: any = { id: 1, value: "y" };
		b.self = b;

		expect(
			deepEqualExcept(a, b, {
				ignoreKeys: ["id"],
			}),
		).toBe(false);
	});
});

describe("deepEqualExcept – non-enumerable own string properties", () => {
	const withHidden = (hidden: number) => {
		const obj: Record<string, unknown> = { visible: 1 };
		Object.defineProperty(obj, "hidden", {
			value: hidden,
			writable: true,
			enumerable: false,
			configurable: true,
		});
		return obj;
	};

	it("stays equivalent to deepEqual for objects differing only in a non-enumerable property", () => {
		const a = withHidden(1);
		const b = withHidden(2);

		expect(deepEqual(a, b)).toBe(false);
		expect(deepEqualExcept(a, b, {})).toBe(false);
	});

	it("the omit of nothing round-trips through deepEqual", () => {
		const a = withHidden(1);

		expect(deepEqualExcept(a, withHidden(1), {})).toBe(true);
	});
});

describe("deepEqualExcept – opaque exotics stay consistent with deepEqual", () => {
	it("boxed symbols compare by identity through the omit clone", () => {
		const a = Object(Symbol("a"));

		expect(deepEqualExcept(a, Object(Symbol("b")), {})).toBe(false);
		expect(deepEqualExcept(a, a, {})).toBe(true);
	});
});
