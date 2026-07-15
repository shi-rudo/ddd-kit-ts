import { describe, expect, it, vi } from "vitest";
import {
	DeadlineProcessor,
	type DeadlineProcessorObservers,
	type DeadlineProcessorOptions,
} from "./deadline-processor";
import type { DeadlineStore, DeadLetterDeadline } from "./deadline-store";
import { InMemoryDeadlineStore } from "./in-memory-deadline-store";

type Payload = { kind: string };
type TestProcessorOptions = DeadlineProcessorOptions<Payload>;

// @ts-expect-error legacy optional callbacks must not bypass the required bundle
type RemovedDeadlinePollObserver = TestProcessorOptions["onPollError"];
// @ts-expect-error legacy optional callbacks must not bypass the required bundle
type RemovedDeadlineDeliveryObserver = TestProcessorOptions["onDeliveryError"];
void (undefined as unknown as RemovedDeadlinePollObserver);
void (undefined as unknown as RemovedDeadlineDeliveryObserver);

const at = (iso: string): Date => new Date(iso);
const T0 = "2026-03-01T10:00:00.000Z";
const T1 = "2026-03-01T10:05:00.000Z";

function fastProcessor(
	options: Omit<DeadlineProcessorOptions<Payload>, "observers"> & {
		observers?: Partial<DeadlineProcessorObservers<Payload>>;
	},
): DeadlineProcessor<Payload> {
	const { observers, ...processorOptions } = options;
	return new DeadlineProcessor({
		pollIntervalMs: 1,
		baseDelayMs: 1,
		maxDelayMs: 2,
		random: () => 0.5,
		clock: () => at(T1),
		...processorOptions,
		observers: {
			onDeliveryError: () => {},
			onPollError: () => {},
			onDeadLetter: () => {},
			...observers,
		},
	});
}

/** Runs the processor until `until` resolves, then stops it. */
async function runUntil(
	processor: DeadlineProcessor<Payload>,
	until: () => Promise<void> | void,
): Promise<void> {
	const stop = new AbortController();
	const loop = processor.run(stop.signal);
	try {
		await until();
	} finally {
		stop.abort();
		await loop;
	}
}

/** Polls a (possibly async) condition; fails the test after ~500ms. */
function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	return vi.waitFor(async () => expect(await check()).toBe(true), {
		interval: 1,
		timeout: 500,
	});
}

async function seeded(
	entries: Array<{ key: string; dueAt?: Date; kind?: string }>,
	storeOptions: { maxDeliveryAttempts?: number } = {},
): Promise<InMemoryDeadlineStore<Payload>> {
	const store = new InMemoryDeadlineStore<Payload>(storeOptions);
	for (const entry of entries) {
		await store.schedule({
			scope: "s",
			key: entry.key,
			dueAt: entry.dueAt ?? at(T0),
			payload: { kind: entry.kind ?? entry.key },
		});
	}
	return store;
}

describe("DeadlineProcessor", () => {
	it("requires a complete observer bundle at type and runtime boundaries", () => {
		const store = new InMemoryDeadlineStore<Payload>();

		expect(
			() =>
				// @ts-expect-error productive pollers require explicit operability observers
				new DeadlineProcessor({ store, handler: () => {} }),
		).toThrow(/observers/);
		expect(
			() =>
				new DeadlineProcessor({
					store,
					handler: () => {},
					// @ts-expect-error every operational channel is required
					observers: { onDeliveryError: () => {}, onPollError: () => {} },
				}),
		).toThrow(/onDeadLetter/);
	});

	it("reports the exact dead-letter transition through observers captured at construction", async () => {
		const store = await seeded([{ key: "poison" }], {
			maxDeliveryAttempts: 1,
		});
		const observed: DeadLetterDeadline<Payload>[] = [];
		const options = {
			store,
			handler: () => {
				throw new Error("poison");
			},
			observers: {
				onDeliveryError: () => {},
				onPollError: () => {},
				onDeadLetter: (deadline: DeadLetterDeadline<Payload>) => {
					observed.push(deadline);
				},
			},
		};
		const processor = new DeadlineProcessor(options);
		options.observers.onDeadLetter = () => {};

		await expect(processor.drainOnce()).resolves.toBe("stopped");

		expect(observed).toMatchObject([
			{ scope: "s", key: "poison", attempts: 1, payload: { kind: "poison" } },
		]);
	});

	it("delivers due deadlines to the handler and acknowledges them", async () => {
		const store = await seeded([{ key: "a" }, { key: "b" }]);
		const handled: string[] = [];
		const processor = fastProcessor({
			store,
			handler: (deadline) => {
				handled.push(deadline.key);
			},
		});

		expect(await processor.drainOnce()).toBe("drained");
		expect(handled.sort()).toEqual(["a", "b"]);
		expect(await store.due(at(T1), 10)).toHaveLength(0);
	});

	it("does not deliver deadlines that are not yet due under the injected clock", async () => {
		const store = await seeded([
			{ key: "now", dueAt: at(T0) },
			{ key: "later", dueAt: at("2026-03-01T11:00:00.000Z") },
		]);
		const handled: string[] = [];
		const processor = fastProcessor({
			store,
			handler: (deadline) => {
				handled.push(deadline.key);
			},
		});

		expect(await processor.drainOnce()).toBe("drained");
		expect(handled).toEqual(["now"]);
	});

	it("a failing deadline is reported to markFailed and does not block its neighbors", async () => {
		const store = await seeded([{ key: "poison" }, { key: "healthy" }], {
			maxDeliveryAttempts: 2,
		});
		const handled: string[] = [];
		const errors: string[] = [];
		const processor = fastProcessor({
			store,
			handler: (deadline) => {
				if (deadline.key === "poison") throw new Error("boom");
				handled.push(deadline.key);
			},
			observers: {
				onDeliveryError: (_error, deadline) => {
					errors.push(deadline.key);
				},
			},
		});

		await runUntil(processor, () =>
			eventually(
				async () =>
					handled.includes("healthy") &&
					(await store.deadLetters()).length === 1,
			),
		);

		expect(handled).toEqual(["healthy"]);
		expect(errors.filter((k) => k === "poison").length).toBeGreaterThanOrEqual(
			2,
		);
	});

	it("an ack failure counts as an at-least-once duplicate, never as poison", async () => {
		const inner = await seeded([{ key: "a" }], { maxDeliveryAttempts: 1 });
		let failAcks = 1;
		const store: DeadlineStore<Payload> = {
			schedule: (d) => inner.schedule(d),
			cancel: (s, k) => inner.cancel(s, k),
			due: (now, limit) => inner.due(now, limit),
			markDelivered: async (ids) => {
				if (failAcks > 0) {
					failAcks--;
					throw new Error("ack failed");
				}
				return inner.markDelivered(ids);
			},
			markFailed: (id, e) => inner.markFailed(id, e),
			deadLetters: () => inner.deadLetters(),
		};
		const handled: string[] = [];
		const processor = fastProcessor({
			store,
			handler: (deadline) => {
				handled.push(deadline.key);
			},
		});

		await runUntil(processor, () => eventually(() => handled.length >= 2));

		// Handled twice (the documented duplicate), never dead-lettered:
		// the ceiling of 1 would have tripped on a single markFailed.
		expect(handled.slice(0, 2)).toEqual(["a", "a"]);
		expect(await inner.deadLetters()).toHaveLength(0);
	});

	it("survives transient due() failures, reports them, and backs off", async () => {
		const inner = await seeded([{ key: "a" }]);
		let pollFailures = 2;
		const store: DeadlineStore<Payload> = {
			schedule: (d) => inner.schedule(d),
			cancel: (s, k) => inner.cancel(s, k),
			due: async (now, limit) => {
				if (pollFailures > 0) {
					pollFailures--;
					throw new Error("storage blip");
				}
				return inner.due(now, limit);
			},
			markDelivered: (ids) => inner.markDelivered(ids),
			markFailed: (id, e) => inner.markFailed(id, e),
			deadLetters: () => inner.deadLetters(),
		};
		const handled: string[] = [];
		const pollErrors: unknown[] = [];
		const processor = fastProcessor({
			store,
			handler: (deadline) => {
				handled.push(deadline.key);
			},
			observers: {
				onPollError: (error) => {
					pollErrors.push(error);
				},
			},
		});

		await runUntil(processor, () => eventually(() => handled.length === 1));

		expect(pollErrors).toHaveLength(2);
	});

	it("a drainOnce call during an in-flight pass joins it instead of double-delivering", async () => {
		const store = await seeded([{ key: "a" }]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const handled: string[] = [];
		const processor = fastProcessor({
			store,
			handler: async (deadline) => {
				await gate;
				handled.push(deadline.key);
			},
		});

		const first = processor.drainOnce();
		const second = processor.drainOnce();
		release();

		expect(await first).toBe("drained");
		expect(await second).toBe("drained");
		expect(handled).toEqual(["a"]);
	});

	it("run(signal) shuts down gracefully even while a joined signal-less pass is mid-flight", async () => {
		const store = await seeded([{ key: "a" }]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const processor = fastProcessor({
			store,
			handler: async () => {
				await gate;
			},
		});

		const cronPass = processor.drainOnce();
		const stop = new AbortController();
		const loop = processor.run(stop.signal);
		stop.abort();

		await loop;
		release();
		expect(await cronPass).toBe("drained");
	});

	it("throwing observers, clock, and jitter source are neutralized", async () => {
		const store = await seeded([{ key: "poison" }, { key: "healthy" }], {
			maxDeliveryAttempts: 1,
		});
		const handled: string[] = [];
		const processor = fastProcessor({
			store,
			handler: (deadline) => {
				if (deadline.key === "poison") throw new Error("boom");
				handled.push(deadline.key);
			},
			clock: () => {
				throw new Error("clock bug"); // degrades to system time; T0 is past
			},
			random: () => {
				throw new Error("jitter bug");
			},
			observers: {
				onDeliveryError: () => {
					throw new Error("observer bug");
				},
			},
		});

		await runUntil(processor, () => eventually(() => handled.length === 1));

		expect(handled).toEqual(["healthy"]);
		expect(await store.deadLetters()).toHaveLength(1);
	});

	it("acknowledges a cycle's deliveries in one batch call, and an ack failure ends the cycle reporting every handled deadline", async () => {
		const inner = await seeded([{ key: "a" }, { key: "b" }], {
			maxDeliveryAttempts: 1,
		});
		const ackCalls: ReadonlyArray<string>[] = [];
		let failAcks = 1;
		const store: DeadlineStore<Payload> = {
			schedule: (d) => inner.schedule(d),
			cancel: (s, k) => inner.cancel(s, k),
			due: (now, limit) => inner.due(now, limit),
			markDelivered: async (ids) => {
				ackCalls.push(ids);
				if (failAcks > 0) {
					failAcks--;
					throw new Error("write path down");
				}
				return inner.markDelivered(ids);
			},
			markFailed: (id, e) => inner.markFailed(id, e),
			deadLetters: () => inner.deadLetters(),
		};
		const handled: string[] = [];
		const reported: string[] = [];
		const processor = fastProcessor({
			store,
			handler: (deadline) => {
				handled.push(deadline.key);
			},
			observers: {
				onDeliveryError: (_error, deadline) => {
					reported.push(deadline.key);
				},
			},
		});

		await runUntil(processor, () => eventually(() => handled.length >= 4));

		// One markDelivered call per cycle carrying BOTH ids.
		expect(ackCalls[0]).toHaveLength(2);
		// The failed ack reported every handled deadline of the cycle, and
		// nothing was dead-lettered (ceiling 1 would have tripped).
		expect(reported.slice(0, 2).sort()).toEqual(["a", "b"]);
		expect(await inner.deadLetters()).toHaveLength(0);
	});

	it("a clock returning an Invalid Date degrades to system time instead of silently halting delivery", async () => {
		const store = await seeded([{ key: "a" }]); // due in the past
		const handled: string[] = [];
		const processor = fastProcessor({
			store,
			handler: (deadline) => {
				handled.push(deadline.key);
			},
			clock: () => new Date(Number.NaN),
		});

		expect(await processor.drainOnce()).toBe("drained");
		expect(handled).toEqual(["a"]);
	});

	it("rejects invalid numeric options at construction", () => {
		const store = new InMemoryDeadlineStore<Payload>();
		const handler = (): void => {};
		expect(() => fastProcessor({ store, handler, batchSize: 0 })).toThrow(
			/batchSize/,
		);
		expect(() => fastProcessor({ store, handler, pollIntervalMs: -1 })).toThrow(
			/pollIntervalMs/,
		);
	});
});
