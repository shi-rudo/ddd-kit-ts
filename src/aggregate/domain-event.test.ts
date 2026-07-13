import { afterEach, describe, expect, it } from "vitest";
import { HostileStateKeyError } from "../core/errors";
import {
	copyMetadata,
	createDomainEvent,
	type DomainEvent,
	type EventMetadata,
	mergeMetadata,
	resetClockFactory,
	resetEventIdFactory,
	setClockFactory,
	setEventIdFactory,
	withClockFactory,
	withEventIdFactory,
} from "./domain-event";

describe("DomainEvent", () => {
	describe("eventId", () => {
		it("auto-generates a non-empty string eventId", () => {
			const event = createDomainEvent("Demo", { x: 1 });
			expect(typeof event.eventId).toBe("string");
			expect(event.eventId.length).toBeGreaterThan(0);
		});

		it("produces a different eventId for each invocation", () => {
			const a = createDomainEvent("Demo", { x: 1 });
			const b = createDomainEvent("Demo", { x: 1 });
			expect(a.eventId).not.toBe(b.eventId);
		});

		it("uses an explicit eventId when provided via options", () => {
			const event = createDomainEvent(
				"Demo",
				{ x: 1 },
				{
					eventId: "evt-explicit-123",
				},
			);
			expect(event.eventId).toBe("evt-explicit-123");
		});

		it("also auto-generates eventId for payload-less events", () => {
			const event = createDomainEvent("PayloadFreeEvent");
			expect(typeof event.eventId).toBe("string");
			expect(event.eventId.length).toBeGreaterThan(0);
		});

		it("preserves the consumer-supplied eventId through createDomainEvent", () => {
			const event = createDomainEvent(
				"Demo",
				{ x: 1 },
				{ eventId: "evt-X", metadata: { correlationId: "corr-1" } },
			);
			expect(event.eventId).toBe("evt-X");
		});
	});

	describe("aggregateId / aggregateType", () => {
		it("captures aggregateId and aggregateType when provided", () => {
			const event = createDomainEvent(
				"OrderCreated",
				{ customerId: "c-1" },
				{
					aggregateId: "order-42",
					aggregateType: "Order",
				},
			);
			expect(event.aggregateId).toBe("order-42");
			expect(event.aggregateType).toBe("Order");
		});

		it("leaves both fields undefined when not provided", () => {
			const event = createDomainEvent("Demo", { x: 1 });
			expect(event.aggregateId).toBeUndefined();
			expect(event.aggregateType).toBeUndefined();
		});

		it("allows aggregateId without aggregateType (and vice versa)", () => {
			const a = createDomainEvent("Demo", { x: 1 }, { aggregateId: "id-1" });
			const b = createDomainEvent("Demo", { x: 1 }, { aggregateType: "X" });
			expect(a.aggregateId).toBe("id-1");
			expect(a.aggregateType).toBeUndefined();
			expect(b.aggregateId).toBeUndefined();
			expect(b.aggregateType).toBe("X");
		});

		it("propagates aggregateId/aggregateType through createDomainEvent", () => {
			const event = createDomainEvent(
				"OrderShipped",
				{ trackingNumber: "T-1" },
				{
					aggregateId: "order-42",
					aggregateType: "Order",
					metadata: { correlationId: "corr-1" },
				},
			);
			expect(event.aggregateId).toBe("order-42");
			expect(event.aggregateType).toBe("Order");
		});
	});

	describe("payload semantics", () => {
		it("sets payload to undefined for payload-less events", () => {
			const event = createDomainEvent("PayloadFreeEvent");
			expect("payload" in event).toBe(true);
			expect(event.payload).toBeUndefined();
		});

		it("preserves the payload by value while isolating it from the caller", () => {
			const payload = { orderId: "o-1", items: 3 };
			const event = createDomainEvent("OrderCreated", payload);
			// Value equality, NOT identity: like occurredAt, the payload is
			// defensively cloned so the event never aliases (or freezes) the
			// caller's own object.
			expect(event.payload).toEqual(payload);
			expect(event.payload).not.toBe(payload);
		});
	});

	describe("input ownership: caller objects are never frozen in place", () => {
		it("leaves the caller's payload object graph mutable after event creation", () => {
			const item = { sku: "a", qty: 1 };
			const payload = { items: [item] };
			const event = createDomainEvent("Demo", payload);

			expect(Object.isFrozen(payload)).toBe(false);
			expect(Object.isFrozen(item)).toBe(false);
			item.qty = 2; // must not throw
			expect(item.qty).toBe(2);

			// The event stays deeply frozen and isolated from the mutation.
			expect(Object.isFrozen(event.payload)).toBe(true);
			expect(Object.isFrozen(event.payload.items[0])).toBe(true);
			expect(event.payload.items[0]?.qty).toBe(1);
		});

		it("leaves a metadata object reusable across events", () => {
			const metadata: EventMetadata = { correlationId: "corr-1" };
			const first = createDomainEvent("Demo", { x: 1 }, { metadata });

			expect(Object.isFrozen(metadata)).toBe(false);
			metadata.causationId = first.eventId; // must not throw
			const second = createDomainEvent("Demo", { x: 2 }, { metadata });

			expect(first.metadata?.causationId).toBeUndefined();
			expect(second.metadata?.causationId).toBe(first.eventId);
		});

		it("rejects payloads that are not plain structured-cloneable data", () => {
			expect(() =>
				createDomainEvent("Demo", { callback: () => "not data" }),
			).toThrow(TypeError);
			expect(() => createDomainEvent("Demo", () => "not data")).toThrow(
				TypeError,
			);
		});
	});

	describe("existing fields still set correctly", () => {
		it("defaults occurredAt to the current time", () => {
			const before = Date.now();
			const event = createDomainEvent("Demo", { x: 1 });
			const after = Date.now();
			expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
			expect(event.occurredAt.getTime()).toBeLessThanOrEqual(after);
		});

		it("defaults version to 1", () => {
			const event = createDomainEvent("Demo", { x: 1 });
			expect(event.version).toBe(1);
		});

		it("honors explicit occurredAt / version overrides", () => {
			const when = new Date("2026-01-01T00:00:00Z");
			const event = createDomainEvent(
				"Demo",
				{ x: 1 },
				{
					occurredAt: when,
					version: 7,
				},
			);
			// Value equality, NOT identity: the event defensively copies the
			// caller's Date so later mutation of `when` cannot bleed in.
			expect(event.occurredAt.getTime()).toBe(when.getTime());
			expect(event.version).toBe(7);
		});
	});

	describe("EventIdFactory hook", () => {
		afterEach(() => {
			resetEventIdFactory();
		});

		it("uses a custom global factory when set via setEventIdFactory", () => {
			let counter = 0;
			setEventIdFactory(() => `seq-${++counter}`);

			const a = createDomainEvent("Demo", { x: 1 });
			const b = createDomainEvent("Demo", { x: 2 });

			expect(a.eventId).toBe("seq-1");
			expect(b.eventId).toBe("seq-2");
		});

		it("per-call eventId override takes precedence over the global factory", () => {
			setEventIdFactory(() => "factory-id");

			const event = createDomainEvent(
				"Demo",
				{ x: 1 },
				{
					eventId: "explicit-id",
				},
			);
			expect(event.eventId).toBe("explicit-id");
		});

		it("resetEventIdFactory restores the default", () => {
			setEventIdFactory(() => "custom");
			expect(createDomainEvent("Demo").eventId).toBe("custom");

			resetEventIdFactory();
			const reset = createDomainEvent("Demo");
			expect(reset.eventId).not.toBe("custom");
			expect(reset.eventId.length).toBeGreaterThan(0);
		});

		it("supports ULID/KSUID/etc. by accepting any string-producing factory", () => {
			const fakeUlid = "01HZ4Y3Y6T7M8X9YDE0FGH1234";
			setEventIdFactory(() => fakeUlid);

			const event = createDomainEvent("Demo", { x: 1 });
			expect(event.eventId).toBe(fakeUlid);
		});

		it("invokes the factory afresh on every event (no caching)", () => {
			let calls = 0;
			setEventIdFactory(() => `call-${++calls}`);

			createDomainEvent("Demo", { x: 1 });
			createDomainEvent("Demo", { x: 2 });
			createDomainEvent("Demo", { x: 3 });
			expect(calls).toBe(3);
		});
	});

	describe("ClockFactory hook", () => {
		afterEach(() => {
			resetClockFactory();
		});

		it("uses a custom global clock when set via setClockFactory", () => {
			const fixed = new Date("2026-01-01T00:00:00Z");
			setClockFactory(() => fixed);

			const event = createDomainEvent("Demo", { x: 1 });
			expect(event.occurredAt.getTime()).toBe(fixed.getTime());
		});

		it("per-call occurredAt override takes precedence over the global factory", () => {
			setClockFactory(() => new Date("2026-01-01T00:00:00Z"));

			const explicit = new Date("2030-12-31T00:00:00Z");
			const event = createDomainEvent(
				"Demo",
				{ x: 1 },
				{
					occurredAt: explicit,
				},
			);

			expect(event.occurredAt.getTime()).toBe(explicit.getTime());
		});

		it("resetClockFactory restores the default", () => {
			setClockFactory(() => new Date(0));
			expect(createDomainEvent("Demo").occurredAt.getTime()).toBe(0);

			resetClockFactory();

			const before = Date.now();
			const reset = createDomainEvent("Demo");
			const after = Date.now();
			expect(reset.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
			expect(reset.occurredAt.getTime()).toBeLessThanOrEqual(after);
		});

		it("invokes the factory afresh on every event (no caching)", () => {
			let n = 0;
			setClockFactory(() => new Date(++n));

			createDomainEvent("Demo");
			createDomainEvent("Demo");
			createDomainEvent("Demo");
			expect(n).toBe(3);
		});
	});

	describe("Scoped factory helpers: withEventIdFactory / withClockFactory", () => {
		afterEach(() => {
			// Defence in depth: every test in this block should leave
			// state clean via the scoped helper's try/finally, but reset
			// anyway in case a future addition mutates the global directly.
			resetEventIdFactory();
			resetClockFactory();
		});

		it("withEventIdFactory installs the factory during fn and restores after", () => {
			const captured = withEventIdFactory(
				() => "scoped-evt",
				() => createDomainEvent("Demo", { x: 1 }).eventId,
			);
			expect(captured).toBe("scoped-evt");

			// After the scoped block, the default is back.
			const after = createDomainEvent("Demo", { x: 1 }).eventId;
			expect(after).not.toBe("scoped-evt");
		});

		it("withEventIdFactory restores even when fn throws", () => {
			expect(() => {
				withEventIdFactory(
					() => "scoped-evt",
					() => {
						throw new Error("boom");
					},
				);
			}).toThrow("boom");

			// Factory was restored despite the throw.
			const after = createDomainEvent("Demo", { x: 1 }).eventId;
			expect(after).not.toBe("scoped-evt");
		});

		it("withEventIdFactory composes via nesting (inner restores to outer)", () => {
			const trail: string[] = [];

			withEventIdFactory(
				() => "outer",
				() => {
					trail.push(createDomainEvent("Demo", { x: 1 }).eventId);

					withEventIdFactory(
						() => "inner",
						() => {
							trail.push(createDomainEvent("Demo", { x: 1 }).eventId);
						},
					);

					// Inner restored to outer.
					trail.push(createDomainEvent("Demo", { x: 1 }).eventId);
				},
			);

			expect(trail).toEqual(["outer", "inner", "outer"]);

			// Outer restored to default.
			expect(createDomainEvent("Demo", { x: 1 }).eventId).not.toBe("outer");
		});

		it("withEventIdFactory returns the value produced by fn", () => {
			const out = withEventIdFactory(
				() => "scoped",
				() => ({ ok: true, count: 42 }),
			);
			expect(out).toEqual({ ok: true, count: 42 });
		});

		it("withClockFactory installs the factory during fn and restores after", () => {
			const fixed = new Date("2026-01-01T00:00:00Z");
			const capturedTime = withClockFactory(
				() => fixed,
				() => createDomainEvent("Demo", { x: 1 }).occurredAt.getTime(),
			);
			expect(capturedTime).toBe(fixed.getTime());

			// Default Date factory restored.
			const before = Date.now();
			const after = createDomainEvent("Demo", { x: 1 }).occurredAt.getTime();
			const stop = Date.now();
			expect(after).toBeGreaterThanOrEqual(before);
			expect(after).toBeLessThanOrEqual(stop);
		});

		it("withClockFactory restores even when fn throws", () => {
			const fixed = new Date("1999-12-31T23:59:59Z");
			expect(() => {
				withClockFactory(
					() => fixed,
					() => {
						throw new Error("clock-boom");
					},
				);
			}).toThrow("clock-boom");

			const after = createDomainEvent("Demo", { x: 1 }).occurredAt;
			expect(after.getTime()).not.toBe(fixed.getTime());
		});

		it("withClockFactory composes via nesting (inner restores to outer)", () => {
			const outerDate = new Date("2026-01-01T00:00:00Z");
			const innerDate = new Date("2026-06-15T12:00:00Z");
			const times: number[] = [];

			withClockFactory(
				() => outerDate,
				() => {
					times.push(createDomainEvent("Demo").occurredAt.getTime());

					withClockFactory(
						() => innerDate,
						() => {
							times.push(createDomainEvent("Demo").occurredAt.getTime());
						},
					);

					times.push(createDomainEvent("Demo").occurredAt.getTime());
				},
			);

			expect(times).toEqual([
				outerDate.getTime(),
				innerDate.getTime(),
				outerDate.getTime(),
			]);
		});

		it("withEventIdFactory throws if fn returns a thenable (async-misuse guard)", () => {
			// JS spec: try { return fn() } finally { restore } runs the
			// finally BEFORE the Promise resolves. So an async fn would
			// see the restored (previous) factory in its awaited body:
			// silent corruption. The guard catches this at write time.
			expect(() =>
				withEventIdFactory(() => "scoped", (async () =>
					createDomainEvent("X", {})) as unknown as () => void),
			).toThrow(/withEventIdFactory.*thenable/);

			// And the factory was restored despite the throw.
			const after = createDomainEvent("Demo", { x: 1 }).eventId;
			expect(after).not.toBe("scoped");
		});

		it("withClockFactory throws if fn returns a thenable (async-misuse guard)", () => {
			const fixed = new Date("1999-12-31T23:59:59Z");
			expect(() =>
				withClockFactory(() => fixed, (async () =>
					createDomainEvent("X", {})) as unknown as () => void),
			).toThrow(/withClockFactory.*thenable/);

			const after = createDomainEvent("Demo", { x: 1 }).occurredAt;
			expect(after.getTime()).not.toBe(fixed.getTime());
		});

		it("guards also catch raw thenables (object with a then method), not just real Promises", () => {
			// biome-ignore lint/suspicious/noThenProperty: this test intentionally builds a raw thenable.
			const fakeThenable = { then: () => {} };
			expect(() =>
				withEventIdFactory(
					() => "scoped",
					() => fakeThenable as unknown as void,
				),
			).toThrow(/thenable/);
		});
	});

	describe("Immutability: events are deeply frozen at construction", () => {
		it("returns a top-level frozen event", () => {
			const event = createDomainEvent("Demo", { x: 1 });
			expect(Object.isFrozen(event)).toBe(true);
			expect(() => {
				(event as unknown as Record<string, unknown>).injected = "evil";
			}).toThrow();
		});

		it("deeply freezes the payload so nested writes throw", () => {
			const event = createDomainEvent("Demo", {
				nested: { value: 1 },
			});
			expect(Object.isFrozen(event.payload.nested)).toBe(true);
			expect(() => {
				(event.payload.nested as { value: number }).value = 99;
			}).toThrow();
		});

		it("deeply freezes metadata (so a mutating consumer cannot rewrite correlationId in flight)", () => {
			const event = createDomainEvent(
				"Demo",
				{ x: 1 },
				{ metadata: { correlationId: "corr-1", extra: { tag: "a" } } },
			);
			expect(Object.isFrozen(event.metadata)).toBe(true);
			expect(() => {
				(event.metadata as { extra: { tag: string } }).extra.tag = "evil";
			}).toThrow();
		});

		it("payload-less events still produce a frozen event", () => {
			const event = createDomainEvent("PayloadFree");
			expect(Object.isFrozen(event)).toBe(true);
		});

		it("blocks occurredAt mutation so a subscriber cannot poison the timestamp", () => {
			const event = createDomainEvent("Demo", { x: 1 });
			const before = event.occurredAt.getTime();

			expect(() => event.occurredAt.setTime(0)).toThrow(TypeError);
			expect(event.occurredAt.getTime()).toBe(before);
		});

		it("does not share the caller's Date instance passed as options.occurredAt", () => {
			const when = new Date("2020-01-01T00:00:00Z");
			const event = createDomainEvent("Demo", { x: 1 }, { occurredAt: when });

			expect(event.occurredAt.getTime()).toBe(
				new Date("2020-01-01T00:00:00Z").getTime(),
			);
			// Mutating the caller's Date later must not bleed into the event.
			when.setTime(0);
			expect(event.occurredAt.getTime()).not.toBe(0);
		});

		it("blocks Map/Set mutators inside frozen payloads", () => {
			const event = createDomainEvent("Demo", {
				tags: new Set(["a"]),
				counts: new Map([["x", 1]]),
			});

			expect(() => event.payload.tags.add("b")).toThrow(TypeError);
			expect(() => event.payload.counts.set("y", 2)).toThrow(TypeError);
		});
	});

	describe("mergeMetadata prototype-pollution safety", () => {
		it("rejects a parsed __proto__ key loudly (same contract as entity state)", () => {
			const hostile = JSON.parse('{"__proto__": {"isAdmin": true}}') as Record<
				string,
				unknown
			>;

			// Preserving the key as data would re-arm pollution in every
			// downstream [[Set]]-based consumer of the metadata; dropping it
			// would be silent mutation. Loud rejection is the one safe
			// contract, and the global prototype stays clean.
			expect(() => mergeMetadata({ correlationId: "corr-1" }, hostile)).toThrow(
				HostileStateKeyError,
			);
			expect(({} as Record<string, unknown>).isAdmin).toBeUndefined();
		});
	});

	describe("copyMetadata interaction", () => {
		it("does not copy eventId or aggregateId fields (those are per-event identity, not metadata)", () => {
			const previous: DomainEvent<"Prev", { v: number }> = createDomainEvent(
				"Prev",
				{ v: 1 },
				{
					aggregateId: "order-42",
					aggregateType: "Order",
					metadata: { correlationId: "corr-1" },
				},
			);
			const copied = copyMetadata(previous);
			expect((copied as Record<string, unknown>).eventId).toBeUndefined();
			expect((copied as Record<string, unknown>).aggregateId).toBeUndefined();
			expect(copied.correlationId).toBe("corr-1");
		});
	});
});

describe("clock ownership: a shared Date from the factory is never frozen or aliased", () => {
	it("createDomainEvent copies the now() result before the deep freeze", () => {
		const fixed = new Date("2026-01-01T00:00:00Z");
		withClockFactory(
			() => fixed,
			() => {
				const event = createDomainEvent("Ticked", {});
				expect(event.occurredAt.getTime()).toBe(fixed.getTime());
				expect(event.occurredAt).not.toBe(fixed);
				expect(Object.isFrozen(fixed)).toBe(false);
				// The caller's later mutation must neither throw nor bleed
				// into the already-created event.
				fixed.setFullYear(2030);
				expect(event.occurredAt.getFullYear()).toBe(2026);
			},
		);
	});
});

describe("createDomainEvent metadata is guarded at the source", () => {
	it("rejects options.metadata carrying an own __proto__ key", () => {
		const hostile = JSON.parse(
			'{"correlationId":"c-1","__proto__":{"isAdmin":true}}',
		) as Record<string, unknown>;

		expect(() =>
			createDomainEvent("Ticked", {}, { metadata: hostile }),
		).toThrow(HostileStateKeyError);
	});

	it("copyMetadata rejects hostile ADDITIONAL metadata", () => {
		const event = createDomainEvent("Ticked", {});
		const hostile = JSON.parse(
			'{"correlationId":"c-1","__proto__":{"isAdmin":true}}',
		) as Record<string, unknown>;

		expect(() => copyMetadata(event, hostile)).toThrow(HostileStateKeyError);
	});

	it("copyMetadata also rejects a hostile SOURCE event (hand-built, not via createDomainEvent)", () => {
		const handBuilt = {
			eventId: "e1",
			type: "T",
			aggregateType: "A",
			occurredAt: new Date(),
			version: 1,
			payload: {},
			metadata: JSON.parse('{"__proto__":{"isAdmin":true}}') as Record<
				string,
				unknown
			>,
		};

		expect(() => copyMetadata(handBuilt as never)).toThrow(
			HostileStateKeyError,
		);
	});
});

describe("commit cursor boundary", () => {
	it("keeps persistence cursor fields off the domain event", () => {
		const event = createDomainEvent("Ticked", {});

		expect(Object.hasOwn(event, "aggregateVersion")).toBe(false);
		expect(Object.hasOwn(event, "commitSequence")).toBe(false);
		expect(Object.hasOwn(event, "commitSize")).toBe(false);
		expect(Object.hasOwn(event, "previousEventfulAggregateVersion")).toBe(
			false,
		);
	});

	it("does not accept persistence cursor fields as creation options", () => {
		const invalidCreation = () => {
			// @ts-expect-error commit positions belong to CommittedDomainEvent
			createDomainEvent(
				"Ticked",
				{},
				{
					commitSize: 2,
				},
			);
		};

		expect(invalidCreation).toBeTypeOf("function");
	});
});

describe("binary payloads are rejected at the mint", () => {
	// Freezing cannot make buffers immutable (the spec forbids freezing
	// a view with elements, and a frozen view still shares its mutable
	// buffer), so accepting them would falsify "minted implies deeply
	// frozen". They do not survive JSON either.
	it("rejects a top-level TypedArray payload", () => {
		expect(() =>
			createDomainEvent("BinaryEvent", new Uint8Array([1, 2, 3])),
		).toThrow(/binary buffers/);
	});

	it("rejects buffers nested in payload objects, arrays, Maps, and Sets", () => {
		expect(() =>
			createDomainEvent("BinaryEvent", { blob: new Uint8Array(4) }),
		).toThrow(/binary buffers/);
		expect(() =>
			createDomainEvent("BinaryEvent", {
				rows: [{ raw: new DataView(new ArrayBuffer(4)) }],
			}),
		).toThrow(/binary buffers/);
		expect(() =>
			createDomainEvent("BinaryEvent", { buf: new ArrayBuffer(8) }),
		).toThrow(/binary buffers/);
		expect(() =>
			createDomainEvent("BinaryEvent", {
				m: new Map([["k", new Uint8Array(1)]]),
			}),
		).toThrow(/binary buffers/);
		expect(() =>
			createDomainEvent("BinaryEvent", { s: new Set([new Uint8Array(1)]) }),
		).toThrow(/binary buffers/);
	});

	it("rejects buffers in metadata too", () => {
		expect(() =>
			createDomainEvent(
				"BinaryEvent",
				{ ok: true },
				{ metadata: { raw: new Uint8Array(2) } },
			),
		).toThrow(/binary buffers/);
	});

	it("still accepts plain JSON-like data, Dates, Maps, and Sets", () => {
		const event = createDomainEvent("PlainEvent", {
			text: "a",
			n: 1,
			when: new Date(0),
			tags: new Set(["x"]),
			pairs: new Map([["k", "v"]]),
			nested: [{ deep: true }],
		});
		expect(Object.isFrozen(event.payload)).toBe(true);
	});
});
