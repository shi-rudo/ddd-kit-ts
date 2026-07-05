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

	it("preserves sparse holes and filters custom string and symbol properties", () => {
		const kept = Symbol("kept");
		const ignored = Symbol("ignored");
		const input = new Array<{ id: number }>(2) as Array<{ id: number }> &
			Record<PropertyKey, unknown>;
		input[1] = { id: 1 };
		input.label = "remove";
		input[kept] = { nested: true };
		input[ignored] = "remove";

		const result = deepOmit(input, {
			ignoreKeys: ["label", ignored, "id"],
		});

		expect(0 in result).toBe(false);
		expect(result[1]).toEqual({});
		expect(Object.hasOwn(result, "label")).toBe(false);
		expect(result[kept]).toEqual({ nested: true });
		expect(Object.hasOwn(result, ignored)).toBe(false);
	});

	it("preserves a non-writable array length descriptor", () => {
		const input = [1, 2];
		Object.defineProperty(input, "length", { writable: false });

		const result = deepOmit(input, { ignoreKeys: [] });

		expect(Object.getOwnPropertyDescriptor(result, "length")).toEqual(
			Object.getOwnPropertyDescriptor(input, "length"),
		);
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

	it("never drops array elements even when a predicate matches their index", () => {
		// Key filtering is for object properties, not array elements. A
		// predicate written to strip a config key named "2" must not silently
		// delete array index 2 and leave a hole.
		const result = deepOmit(["a", "b", "c"], {
			ignoreKeyPredicate: (key) => key === "2",
		});

		expect(result).toEqual(["a", "b", "c"]);
		expect(result).toHaveLength(3);
		expect("2" in result).toBe(true);
	});

	it("never drops array elements matched by ignoreKeys index strings", () => {
		const result = deepOmit(["a", "b", "c"], { ignoreKeys: ["1"] });

		expect(result).toEqual(["a", "b", "c"]);
	});

	it("still filters custom (non-index) own properties on an array", () => {
		const input: string[] & { meta?: string } = ["a", "b"];
		input.meta = "secret";

		const result = deepOmit(input, { ignoreKeys: ["meta"] }) as string[] & {
			meta?: string;
		};

		expect([...result]).toEqual(["a", "b"]);
		expect("meta" in result).toBe(false);
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

describe("deepOmit – Built-ins are cloned atomically (distinct, equal-by-value)", () => {
	it("clones Date by value, not by reference", () => {
		const date = new Date("2024-01-01T00:00:00Z");
		const input = { id: 1, date };
		const result = deepOmit(input, { ignoreKeys: ["id"] }) as { date: Date };

		expect(result).toEqual({ date });
		expect(result.date).not.toBe(date);
		expect(result.date.getTime()).toBe(date.getTime());
	});

	it("clones RegExp by source + flags", () => {
		const re = /abc/gi;
		const input = { pattern: re };
		const result = deepOmit(input, { ignoreKeys: ["x"] }) as {
			pattern: RegExp;
		};
		expect(result.pattern).not.toBe(re);
		expect(result.pattern.source).toBe("abc");
		expect(result.pattern.flags).toBe("gi");
	});

	it("clones Map by entries", () => {
		const map = new Map<string, unknown>([
			["id", 1],
			["value", "x"],
		]);
		const input = { map };
		const result = deepOmit(input, { ignoreKeys: ["id"] }) as {
			map: Map<string, unknown>;
		};
		expect(result.map).not.toBe(map);
		expect([...result.map.entries()]).toEqual([
			["id", 1],
			["value", "x"],
		]);
	});

	it("clones Set by members", () => {
		const a = { id: 1 };
		const b = { id: 2 };
		const set = new Set<object>([a, b]);
		const input = { set };
		const result = deepOmit(input, { ignoreKeys: ["id"] }) as {
			set: Set<object>;
		};
		expect(result.set).not.toBe(set);
		expect(result.set.size).toBe(2);
	});

	it("clones Typed Arrays", () => {
		const arr = new Uint8Array([1, 2, 3]);
		const input = { buffer: arr };
		const result = deepOmit(input, { ignoreKeys: ["buffer2"] }) as {
			buffer: Uint8Array;
		};
		expect(result.buffer).not.toBe(arr);
		expect([...result.buffer]).toEqual([1, 2, 3]);
	});

	it("clones DataView", () => {
		const buf = new ArrayBuffer(4);
		const view = new DataView(buf);
		view.setUint8(0, 42);
		const input = { view, meta: { id: 1 } };
		const result = deepOmit(input, { ignoreKeys: ["id"] }) as {
			view: DataView;
			meta: Record<string, unknown>;
		};
		expect(result.view).not.toBe(view);
		expect(result.view.getUint8(0)).toBe(42);
		expect(result.meta).toEqual({});
	});
});

describe("deepOmit – Reference-compared built-ins are passed through by reference", () => {
	// structuredClone cannot clone Promise/WeakMap/WeakSet, and deepEqual
	// compares Error/ArrayBuffer by reference; cloning any of these would
	// crash or break deepEqualExcept's reflexivity, so they must alias.
	it("passes a Promise through by reference instead of throwing", () => {
		const p = Promise.resolve(1);
		const result = deepOmit({ p, id: 7 }, { ignoreKeys: ["id"] }) as {
			p: Promise<number>;
		};
		expect(result.p).toBe(p);
		expect("id" in result).toBe(false);
	});

	it("passes a WeakMap through by reference instead of throwing", () => {
		const wm = new WeakMap<object, number>();
		const result = deepOmit({ wm }, { ignoreKeys: [] }) as {
			wm: WeakMap<object, number>;
		};
		expect(result.wm).toBe(wm);
	});

	it("passes a WeakSet through by reference instead of throwing", () => {
		const ws = new WeakSet<object>();
		const result = deepOmit({ ws }, { ignoreKeys: [] }) as {
			ws: WeakSet<object>;
		};
		expect(result.ws).toBe(ws);
	});

	it("passes an Error through by reference (deepEqual compares Errors by reference)", () => {
		const e = new TypeError("boom");
		const result = deepOmit({ e, id: 1 }, { ignoreKeys: ["id"] }) as {
			e: Error;
		};
		expect(result.e).toBe(e);
		expect("id" in result).toBe(false);
	});

	it("passes an ArrayBuffer through by reference (deepEqual compares ArrayBuffers by reference)", () => {
		const buf = new ArrayBuffer(8);
		const result = deepOmit({ buf }, { ignoreKeys: [] }) as {
			buf: ArrayBuffer;
		};
		expect(result.buf).toBe(buf);
	});

	it("handles uncloneables nested below the top level", () => {
		const p = Promise.resolve("x");
		const result = deepOmit(
			{ job: { promise: p, secret: 1 } },
			{ ignoreKeys: ["secret"] },
		) as { job: { promise: Promise<string> } };
		expect(result.job.promise).toBe(p);
		expect("secret" in result.job).toBe(false);
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

describe("deepOmit – Built-in atomic types are cloned, not aliased", () => {
	it("returns a distinct Date instance with the same time", () => {
		const input = { stamp: new Date("2026-01-02T03:04:05Z") };
		const result = deepOmit(input, {}) as { stamp: Date };
		expect(result.stamp).not.toBe(input.stamp);
		expect(result.stamp.getTime()).toBe(input.stamp.getTime());
	});

	it("returns a distinct RegExp instance with the same source and flags", () => {
		const input = { rx: /foo/i };
		const result = deepOmit(input, {}) as { rx: RegExp };
		expect(result.rx).not.toBe(input.rx);
		expect(result.rx.source).toBe("foo");
		expect(result.rx.flags).toBe("i");
	});

	it("returns a distinct Map instance with the same entries", () => {
		const input = { m: new Map([["k", 1]]) };
		const result = deepOmit(input, {}) as { m: Map<string, number> };
		expect(result.m).not.toBe(input.m);
		expect([...result.m.entries()]).toEqual([["k", 1]]);
	});

	it("returns a distinct Set instance with the same members", () => {
		const input = { s: new Set([1, 2, 3]) };
		const result = deepOmit(input, {}) as { s: Set<number> };
		expect(result.s).not.toBe(input.s);
		expect([...result.s]).toEqual([1, 2, 3]);
	});
});

describe("deepOmit – Prototype pollution safety", () => {
	it("treats an own __proto__ key as a regular data property, not a prototype write", () => {
		// JSON.parse('{"__proto__":{"polluted":true}}') yields an object whose
		// __proto__ is an OWN property (not a setter call). A naive
		// `clone[key] = value` would then traverse the setter and pollute
		// Object.prototype. deepOmit must keep __proto__ inert.
		const malicious = JSON.parse(
			'{"safe": 1, "__proto__": {"polluted": true}}',
		);

		const result = deepOmit(malicious, {}) as Record<string, unknown>;

		expect(result.safe).toBe(1);
		// The clone should NOT have polluted Object.prototype.
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("does not pollute Object.prototype via 'constructor' own key", () => {
		const malicious = JSON.parse(
			'{"safe": 1, "constructor": {"prototype": {"polluted": true}}}',
		);
		deepOmit(malicious, {});
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});
});

describe("deepOmit – Symbol.toStringTag spoofing", () => {
	it("walks a spoofed Date as a plain object instead of crashing", () => {
		const input = { d: { [Symbol.toStringTag]: "Date", secret: 1, keep: 2 } };

		const result = deepOmit(input, { ignoreKeys: ["secret"] }) as {
			d: { keep: number };
		};

		expect(result.d.keep).toBe(2);
		expect("secret" in result.d).toBe(false);
	});

	it("walks a spoofed Map as a plain object instead of crashing", () => {
		const input = { m: { [Symbol.toStringTag]: "Map", x: 1 } };

		const result = deepOmit(input, { ignoreKeys: [] }) as {
			m: { x: number };
		};

		expect(result.m.x).toBe(1);
	});

	it.each(["Promise", "Error"])(
		"walks a spoofed %s as plain data and applies omissions",
		(tag) => {
			const value = { [Symbol.toStringTag]: tag, secret: 1, keep: 2 };
			const result = deepOmit(value, { ignoreKeys: ["secret"] }) as {
				keep: number;
			};

			expect(result).not.toBe(value);
			expect(result.keep).toBe(2);
			expect("secret" in result).toBe(false);
		},
	);

	it("still clones real built-ins by type (regression guard)", () => {
		const input = { d: new Date(5), m: new Map([["k", 1]]) };
		const result = deepOmit(input, {}) as { d: Date; m: Map<string, number> };

		expect(result.d).not.toBe(input.d);
		expect(result.d.getTime()).toBe(5);
		expect(result.m).not.toBe(input.m);
		expect(result.m.get("k")).toBe(1);
	});
});

describe("deepOmit – shared references (DAG) vs cycles with path-sensitive predicates", () => {
	it("evaluates the predicate per path when the same object is shared under two keys", () => {
		const shared = { x: 1, y: 2 };
		const result = deepOmit(
			{ a: shared, b: shared },
			{
				ignoreKeyPredicate: (key, path) => key === "x" && path[0] === "a",
			},
		) as { a: { x?: number; y: number }; b: { x?: number; y: number } };

		// Path-sensitive: "x" is ignored under "a" only.
		expect("x" in result.a).toBe(false);
		expect(result.b.x).toBe(1);
		expect(result.a.y).toBe(2);
		expect(result.b.y).toBe(2);
	});

	it("still terminates on cycles when a predicate is used", () => {
		const node: any = { id: 1, secret: "s" };
		node.self = node;

		const result = deepOmit(node, {
			ignoreKeyPredicate: (key) => key === "secret",
		}) as any;

		expect(result.id).toBe(1);
		expect("secret" in result).toBe(false);
		expect(result.self).toBe(result); // cycle preserved
	});

	it("keeps deduping shared references when no predicate is involved (regression guard)", () => {
		const shared = { x: 1, y: 2 };
		const result = deepOmit(
			{ a: shared, b: shared },
			{ ignoreKeys: ["x"] },
		) as { a: object; b: object };

		// ignoreKeys is path-independent, so structure sharing is safe and kept.
		expect(result.a).toBe(result.b);
		expect(result.a).toEqual({ y: 2 });
	});

	it("aborts with a descriptive error instead of hanging on exponentially shared graphs", () => {
		// Per-path cloning is semantically forced with a predicate, so a
		// diamond chain (every level shares one node via two keys) expands
		// 2^depth; the walk must fail loudly, not freeze the process.
		let node: Record<string, unknown> = { leaf: 1 };
		for (let i = 0; i < 24; i++) {
			node = { a: node, b: node };
		}

		expect(() => deepOmit(node, { ignoreKeyPredicate: () => false })).toThrow(
			/shared references/,
		);
	});
});

describe("deepOmit – non-enumerable own string properties", () => {
	// deepEqual compares plain objects via Object.getOwnPropertyNames
	// (test-pinned there), so the omit clone must preserve exactly that
	// key set or deepEqualExcept diverges from deepEqual.
	const withHidden = (visible: number, hidden: number) => {
		const obj: Record<string, unknown> = { visible };
		Object.defineProperty(obj, "hidden", {
			value: hidden,
			writable: true,
			enumerable: false,
			configurable: true,
		});
		return obj;
	};

	it("preserves a non-enumerable own string property including its enumerability", () => {
		const clone = deepOmit(withHidden(1, 2), {});

		const descriptor = Object.getOwnPropertyDescriptor(clone, "hidden");
		expect(descriptor?.value).toBe(2);
		expect(descriptor?.enumerable).toBe(false);
		// The enumerable sibling stays enumerable.
		expect(Object.getOwnPropertyDescriptor(clone, "visible")?.enumerable).toBe(
			true,
		);
	});

	it("still applies ignore rules to non-enumerable keys", () => {
		const clone = deepOmit(withHidden(1, 2), { ignoreKeys: ["hidden"] });

		expect(Object.hasOwn(clone, "hidden")).toBe(false);
	});
});
