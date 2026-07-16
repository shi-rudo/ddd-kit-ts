import { describe, expect, it, vi } from "vite-plus/test";
import { createDomainEvent, type DomainEvent } from "../aggregate/domain-event";
import type { EffectContext } from "../utils/effect";
import { EventBusImpl } from "./event-bus";
import { InMemoryOutbox } from "./outbox";
import {
	eventBusSink,
	OutboxDispatcher,
	type OutboxDispatcherObservers,
	type OutboxDispatcherOptions,
	type OutboxSink,
} from "./outbox-dispatcher";
import type {
	CommittedDomainEvent,
	DeadLetterRecord,
	Outbox,
	OutboxRecord,
} from "./ports";

type TestEvent = DomainEvent<"ThingHappened", { n: number }>;
type TestDispatcherOptions = OutboxDispatcherOptions<TestEvent>;

// @ts-expect-error legacy optional callbacks must not bypass the required bundle
type RemovedDispatcherPollObserver = TestDispatcherOptions["onPollError"];
// @ts-expect-error legacy optional callbacks must not bypass the required bundle
type RemovedDispatcherErrorObserver = TestDispatcherOptions["onDispatchError"];
// @ts-expect-error the v3 classifier uses explicit failure kinds, not a boolean compatibility alias
type RemovedCountsTowardCeiling = TestDispatcherOptions["countsTowardCeiling"];
void (undefined as unknown as RemovedDispatcherPollObserver);
void (undefined as unknown as RemovedDispatcherErrorObserver);
void (undefined as unknown as RemovedCountsTowardCeiling);

function makeEvent(n: number): TestEvent {
	return createDomainEvent("ThingHappened", { n }, { eventId: `evt-${n}` });
}

function makeCommitted(n: number): CommittedDomainEvent<TestEvent> {
	return {
		event: makeEvent(n),
		source: { aggregateId: `thing-${n}`, aggregateType: "Thing" },
		position: {
			aggregateVersion: 1,
			commitSequence: 0,
			commitSize: 1,
			previousEventfulAggregateVersion: null,
		},
	};
}

function fastDispatcher<Evt extends TestEvent>(
	options: Omit<OutboxDispatcherOptions<Evt>, "observers"> & {
		observers?: Partial<OutboxDispatcherObservers<Evt>>;
	},
): OutboxDispatcher<Evt> {
	const { observers, ...dispatcherOptions } = options;
	return new OutboxDispatcher({
		pollIntervalMs: 1,
		baseDelayMs: 1,
		maxDelayMs: 2,
		random: () => 0.5,
		...dispatcherOptions,
		observers: {
			onDispatchError: () => {},
			onPollError: () => {},
			onDeadLetter: () => {},
			...observers,
		},
	});
}

/** Runs the dispatcher until `until` resolves, then stops it. */
async function runUntil<Evt extends TestEvent>(
	dispatcher: OutboxDispatcher<Evt>,
	until: () => Promise<void> | void,
): Promise<void> {
	const stop = new AbortController();
	const loop = dispatcher.run(stop.signal);
	try {
		await until();
	} finally {
		stop.abort();
		await loop;
	}
}

/** Polls a condition via vitest's waitFor; fails the test after ~500ms. */
function eventually(check: () => boolean): Promise<void> {
	return vi.waitFor(() => expect(check()).toBe(true), {
		interval: 1,
		timeout: 500,
	});
}

/** Delegating wrapper around an InMemoryOutbox with targeted overrides. */
function interceptOutbox(
	inner: InMemoryOutbox<TestEvent>,
	overrides: Partial<Outbox<TestEvent>>,
): Outbox<TestEvent> {
	return {
		add: (events) => inner.add(events),
		getPending: (limit) => inner.getPending(limit),
		markDispatched: (ids) => inner.markDispatched(ids),
		...overrides,
	};
}

describe("OutboxDispatcher", () => {
	it("requires a complete observer bundle at type and runtime boundaries", () => {
		const outbox = new InMemoryOutbox<TestEvent>();
		const sink: OutboxSink<TestEvent> = { publish: async () => {} };

		expect(
			() =>
				// @ts-expect-error productive pollers require explicit operability observers
				new OutboxDispatcher({ outbox, sink }),
		).toThrow(/observers/);
		expect(
			() =>
				new OutboxDispatcher({
					outbox,
					sink,
					// @ts-expect-error every operational channel is required
					observers: { onDispatchError: () => {}, onPollError: () => {} },
				}),
		).toThrow(/onDeadLetter/);
	});

	it("reports the exact dead-letter transition through observers captured at construction", async () => {
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 1 });
		await outbox.add([makeCommitted(1)]);
		const observed: DeadLetterRecord<TestEvent>[] = [];
		const options = {
			outbox,
			sink: {
				publish: async () => {
					throw new Error("poison");
				},
			},
			observers: {
				onDispatchError: () => {},
				onPollError: () => {},
				onDeadLetter: (record: DeadLetterRecord<TestEvent>) => {
					observed.push(record);
				},
			},
		};
		const dispatcher = new OutboxDispatcher(options);
		options.observers.onDeadLetter = () => {};

		await expect(dispatcher.drainOnce()).resolves.toBe("stopped");

		expect(observed).toMatchObject([
			{ dispatchId: "evt-1", attempts: 1, event: { eventId: "evt-1" } },
		]);
	});

	it("delivers in commit order and acks the delivered batch in one call, only after publish", async () => {
		const inner = new InMemoryOutbox<TestEvent>();
		await inner.add([makeCommitted(1), makeCommitted(2), makeCommitted(3)]);
		const ackCalls: ReadonlyArray<string>[] = [];
		const outbox = interceptOutbox(inner, {
			markDispatched: async (ids) => {
				ackCalls.push(ids);
				return inner.markDispatched(ids);
			},
		});
		const delivered: number[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({ outbox, sink });
		await runUntil(dispatcher, () => eventually(() => delivered.length === 3));

		expect(delivered).toEqual([1, 2, 3]);
		// Batch ack: one markDispatched call for the whole delivered batch.
		expect(ackCalls[0]).toEqual(["evt-1", "evt-2", "evt-3"]);
		expect(await inner.getPending()).toHaveLength(0);
	});

	it("stops the batch on the first failure, acks the delivered prefix, and preserves order across retries", async () => {
		const inner = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 99 });
		await inner.add([makeCommitted(1), makeCommitted(2), makeCommitted(3)]);
		const ackCalls: ReadonlyArray<string>[] = [];
		const outbox = interceptOutbox(inner, {
			markDispatched: async (ids) => {
				ackCalls.push(ids);
				return inner.markDispatched(ids);
			},
		});
		const delivered: number[] = [];
		let failuresLeft = 2;
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				if (record.event.payload.n === 2 && failuresLeft > 0) {
					failuresLeft--;
					throw new Error("transient");
				}
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({ outbox, sink });
		await runUntil(dispatcher, () => eventually(() => delivered.length === 3));

		// Event 3 must never overtake event 2, and the prefix ack of the
		// failed pass must not include the failed record.
		expect(delivered).toEqual([1, 2, 3]);
		expect(ackCalls[0]).toEqual(["evt-1"]);
	});

	it("survives transient getPending failures and reports them to onPollError", async () => {
		const inner = new InMemoryOutbox<TestEvent>();
		await inner.add([makeCommitted(1)]);
		let pollFailures = 2;
		const outbox = interceptOutbox(inner, {
			getPending: async (limit) => {
				if (pollFailures > 0) {
					pollFailures--;
					throw new Error("storage blip");
				}
				return inner.getPending(limit);
			},
		});
		const delivered: number[] = [];
		const pollErrors: unknown[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({
			outbox,
			sink,
			observers: {
				onPollError: (error) => {
					pollErrors.push(error);
				},
			},
		});
		await runUntil(dispatcher, () => eventually(() => delivered.length === 1));

		expect(delivered).toEqual([1]);
		expect(pollErrors).toHaveLength(2);
	});

	it("aborts a never-settling getPending call through the storage effect context", async () => {
		const inner = new InMemoryOutbox<TestEvent>();
		let context: EffectContext | undefined;
		const outbox = interceptOutbox(inner, {
			getPending: (_limit, received?: EffectContext) => {
				context = received;
				return new Promise<ReadonlyArray<OutboxRecord<TestEvent>>>(() => {});
			},
		});
		const options = {
			outbox,
			sink: { publish: async () => {} },
			storageTimeoutMs: 1_000,
		};
		const dispatcher = fastDispatcher(options);
		const stop = new AbortController();
		const reason = new Error("worker stopping");
		const loop = dispatcher.run(stop.signal);

		stop.abort(reason);
		const outcome = await loop.then(() => "stopped" as const);

		expect(outcome).toBe("stopped");
		expect(context?.signal.reason).toBe(reason);
		expect(context?.deadlineAt).toBeTypeOf("number");
	});

	it("aborts a never-settling outbox acknowledgement without losing the delivered record", async () => {
		const inner = new InMemoryOutbox<TestEvent>();
		await inner.add([makeCommitted(1)]);
		let context: EffectContext | undefined;
		let ackStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			ackStarted = resolve;
		});
		const outbox = interceptOutbox(inner, {
			markDispatched: (_ids, received?: EffectContext) => {
				context = received;
				ackStarted();
				return new Promise<void>(() => {});
			},
		});
		const options = {
			outbox,
			sink: { publish: async () => {} },
			storageTimeoutMs: 1_000,
		};
		const dispatcher = fastDispatcher(options);
		const stop = new AbortController();
		const reason = new Error("worker stopping during ack");
		const loop = dispatcher.run(stop.signal);
		await started;

		stop.abort(reason);
		const outcome = await loop.then(() => "stopped" as const);

		expect(outcome).toBe("stopped");
		expect(context?.signal.reason).toBe(reason);
		expect(await inner.getPending()).toHaveLength(1);
	});

	it("observes one idempotent acknowledgement that completes after its storage timeout", async () => {
		vi.useFakeTimers();
		const inner = new InMemoryOutbox<TestEvent>();
		await inner.add([makeCommitted(1)]);
		let releaseAck!: () => void;
		const ackGate = new Promise<void>((resolve) => {
			releaseAck = resolve;
		});
		let ackStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			ackStarted = resolve;
		});
		let ackCompleted!: () => void;
		const completed = new Promise<void>((resolve) => {
			ackCompleted = resolve;
		});
		let ackCalls = 0;
		const outbox = interceptOutbox(inner, {
			markDispatched: async (ids) => {
				ackCalls += 1;
				ackStarted();
				await ackGate;
				await inner.markDispatched(ids);
				ackCompleted();
			},
		});
		const dispatcher = fastDispatcher({
			outbox,
			sink: { publish: async () => {} },
			storageTimeoutMs: 5,
		});

		try {
			const execution = dispatcher.drainOnce();
			await started;
			await vi.advanceTimersByTimeAsync(5);
			await expect(execution).resolves.toBe("stopped");
			expect(await inner.getPending()).toHaveLength(1);

			releaseAck();
			await completed;
			expect(await inner.getPending()).toHaveLength(0);
			expect(ackCalls).toBe(1);
		} finally {
			releaseAck();
			vi.useRealTimers();
		}
	});

	it("aborts a never-settling outbox failure update without hiding the delivery error", async () => {
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 9 });
		await outbox.add([makeCommitted(1)]);
		let context: EffectContext | undefined;
		let updateStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			updateStarted = resolve;
		});
		outbox.markFailed = (_id, _error, received?: EffectContext) => {
			context = received;
			updateStarted();
			return new Promise(() => {});
		};
		const deliveryError = new Error("permanent rejection");
		const reported: unknown[] = [];
		const options = {
			outbox,
			sink: {
				publish: async () => {
					throw deliveryError;
				},
			},
			storageTimeoutMs: 1_000,
			observers: {
				onDispatchError: (error: unknown) => reported.push(error),
				onPollError: () => {},
				onDeadLetter: () => {},
			},
		};
		const dispatcher = new OutboxDispatcher(options);
		const stop = new AbortController();
		const reason = new Error("worker stopping during failure update");
		const loop = dispatcher.run(stop.signal);
		await started;

		stop.abort(reason);
		const outcome = await loop.then(() => "stopped" as const);

		expect(outcome).toBe("stopped");
		expect(context?.signal.reason).toBe(reason);
		expect(reported).toContain(deliveryError);
	});

	it("reports failures to the tracking outbox so poison messages dead-letter and unblock the queue", async () => {
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 2 });
		await outbox.add([makeCommitted(1), makeCommitted(2)]);
		const delivered: number[] = [];
		const errors: unknown[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				if (record.event.payload.n === 1) throw new Error("poison");
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({
			outbox,
			sink,
			observers: {
				onDispatchError: (error) => {
					errors.push(error);
				},
			},
		});
		await runUntil(dispatcher, () => eventually(() => delivered.length === 1));

		expect(delivered).toEqual([2]);
		const dead = await outbox.deadLetters();
		expect(dead).toHaveLength(1);
		expect(dead[0]?.event.payload.n).toBe(1);
		expect(dead[0]?.attempts).toBe(2);
		expect(errors.length).toBeGreaterThanOrEqual(2);
	});

	it("does not count a failed ack toward the poison ceiling and redelivers instead", async () => {
		const inner = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 1 });
		await inner.add([makeCommitted(1)]);
		let failAcks = 1;
		const outbox = interceptOutbox(inner, {
			markDispatched: async (ids) => {
				if (failAcks > 0) {
					failAcks--;
					throw new Error("ack failed");
				}
				return inner.markDispatched(ids);
			},
		});
		const delivered: number[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({ outbox, sink });
		await runUntil(dispatcher, () => eventually(() => delivered.length >= 2));

		// Delivered twice (the documented at-least-once duplicate), never
		// dead-lettered: the wrapped outbox has a ceiling of 1, which a
		// markFailed report would have tripped.
		expect(delivered.slice(0, 2)).toEqual([1, 1]);
		expect(await inner.deadLetters()).toHaveLength(0);
	});

	it("a drainOnce call during an in-flight pass joins it instead of double-delivering", async () => {
		const outbox = new InMemoryOutbox<TestEvent>();
		await outbox.add([makeCommitted(1), makeCommitted(2)]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const delivered: number[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				await gate;
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({ outbox, sink });
		const first = dispatcher.drainOnce();
		const second = dispatcher.drainOnce(); // overlapping cron tick
		release();

		expect(await first).toBe("drained");
		expect(await second).toBe("drained");
		// One pass, one delivery each: the joining call started no
		// competing poll over the same un-acked records.
		expect(delivered).toEqual([1, 2]);
		expect(await outbox.getPending(10)).toHaveLength(0);
	});

	it("run(signal) shuts down gracefully even while a joined signal-less pass is mid-flight", async () => {
		const outbox = new InMemoryOutbox<TestEvent>();
		await outbox.add([makeCommitted(1)]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sink: OutboxSink<TestEvent> = {
			publish: async () => {
				await gate;
			},
		};

		const dispatcher = fastDispatcher({ outbox, sink });
		// An unbounded cron-style pass, blocked mid-publish.
		const cronPass = dispatcher.drainOnce();
		const stop = new AbortController();
		const loop = dispatcher.run(stop.signal);
		stop.abort();

		// run() must resolve on abort instead of waiting the foreign,
		// signal-less pass out; the pass keeps running for its owner.
		await loop;
		release();
		expect(await cronPass).toBe("drained");
	});

	it("times out a never-settling sink without consuming the poison ceiling", async () => {
		vi.useFakeTimers();
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 99 });
		await outbox.add([makeCommitted(1)]);
		let context: EffectContext | undefined;
		let sinkStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			sinkStarted = resolve;
		});
		const errors: unknown[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (_record, received) => {
				context = received;
				sinkStarted();
				await new Promise<void>(() => {});
			},
		};
		const options = {
			outbox,
			sink,
			deliveryTimeoutMs: 5,
			observers: {
				onDispatchError: (error: unknown) => errors.push(error),
				onPollError: () => {},
				onDeadLetter: () => {},
			},
		};
		const dispatcher = new OutboxDispatcher(options);

		try {
			const execution = dispatcher.drainOnce();
			await started;
			await vi.advanceTimersByTimeAsync(5);
			await expect(execution).resolves.toBe("stopped");

			expect(context?.signal.aborted).toBe(true);
			expect(context?.deadlineAt).toBeTypeOf("number");
			expect(errors).toHaveLength(1);
			expect(errors[0]).toMatchObject({ name: "TimeoutError" });
			const [pending] = await outbox.getPending();
			expect(pending).toMatchObject({ dispatchId: "evt-1", attempts: 0 });
		} finally {
			vi.useRealTimers();
		}
	});

	it("aborts a never-settling sink without counting shutdown as a delivery failure", async () => {
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 1 });
		await outbox.add([makeCommitted(1)]);
		let context: EffectContext | undefined;
		const errors: unknown[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (_record, received) => {
				context = received;
				await new Promise<void>(() => {});
			},
		};
		const dispatcher = fastDispatcher({
			outbox,
			sink,
			observers: { onDispatchError: (error) => errors.push(error) },
		});
		const stop = new AbortController();
		const pass = dispatcher.drainOnce(stop.signal);
		await vi.waitFor(() => expect(context).toBeDefined());

		stop.abort(new Error("worker stopping"));
		const outcome = await pass;

		expect(outcome).toBe("stopped");
		expect(context?.signal.reason).toMatchObject({
			message: "worker stopping",
		});
		expect(errors).toEqual([]);
		const [pending] = await outbox.getPending();
		expect(pending).toMatchObject({ dispatchId: "evt-1", attempts: 0 });
		expect(await outbox.deadLetters()).toEqual([]);
	});

	it("keeps an acknowledged delivery successful when shutdown starts during the outbox ack", async () => {
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 1 });
		await outbox.add([makeCommitted(1)]);
		const persistDispatch = outbox.markDispatched.bind(outbox);
		let ackStarted: () => void = () => {};
		const acknowledging = new Promise<void>((resolve) => {
			ackStarted = resolve;
		});
		let releaseAck: () => void = () => {};
		const ackReleased = new Promise<void>((resolve) => {
			releaseAck = resolve;
		});
		outbox.markDispatched = async (dispatchIds) => {
			ackStarted();
			await ackReleased;
			await persistDispatch(dispatchIds);
		};
		const errors: unknown[] = [];
		const dispatcher = fastDispatcher({
			outbox,
			sink: { publish: async () => {} },
			observers: { onDispatchError: (error) => errors.push(error) },
		});
		const stop = new AbortController();

		const pass = dispatcher.drainOnce(stop.signal);
		await acknowledging;
		stop.abort(new Error("worker stopping"));
		releaseAck();

		// The pass reports worker shutdown, but the already-confirmed record is
		// still acknowledged and is not reclassified as a delivery failure.
		await expect(pass).resolves.toBe("stopped");
		expect(await outbox.getPending()).toEqual([]);
		expect(errors).toEqual([]);
		expect(await outbox.deadLetters()).toEqual([]);
	});

	it("lets broker acknowledgement win when shutdown follows it in the same turn", async () => {
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 1 });
		await outbox.add([makeCommitted(1)]);
		let acknowledge: () => void = () => {};
		let publishStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			publishStarted = resolve;
		});
		const sink: OutboxSink<TestEvent> = {
			publish: () =>
				new Promise<void>((resolve) => {
					acknowledge = resolve;
					publishStarted();
				}),
		};
		const errors: unknown[] = [];
		const dispatcher = fastDispatcher({
			outbox,
			sink,
			observers: { onDispatchError: (error) => errors.push(error) },
		});
		const stop = new AbortController();

		const pass = dispatcher.drainOnce(stop.signal);
		await started;
		acknowledge();
		stop.abort(new Error("worker stopping"));

		await expect(pass).resolves.toBe("stopped");
		expect(await outbox.getPending()).toEqual([]);
		expect(errors).toEqual([]);
		expect(await outbox.deadLetters()).toEqual([]);
	});

	it("transient failures back off without consuming the poison ceiling", async () => {
		// Ceiling 1: the default cause-chain classifier recognizes the broker's
		// retryable marker and keeps the record alive until the outage recovers.
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 1 });
		await outbox.add([makeCommitted(1)]);
		let outage = 3;
		const delivered: number[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				if (outage > 0) {
					outage--;
					throw Object.assign(new Error("broker down"), { retryable: true });
				}
				delivered.push(record.event.payload.n);
			},
		};

		const options = { outbox, sink };
		const dispatcher = fastDispatcher(options);
		await runUntil(dispatcher, () => eventually(() => delivered.length === 1));

		expect(delivered).toEqual([1]);
		expect(await outbox.deadLetters()).toHaveLength(0);
	});

	it("a throwing failure classifier becomes observable unknown failure and cannot break the loop", async () => {
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 1 });
		await outbox.add([makeCommitted(1), makeCommitted(2)]);
		const delivered: number[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				if (record.event.payload.n === 1) throw new Error("poison");
				delivered.push(record.event.payload.n);
			},
		};

		const assessments: unknown[] = [];
		const classifierError = new Error("classifier bug");
		const options = {
			outbox,
			sink,
			classifyFailure: () => {
				throw classifierError;
			},
			observers: {
				onDispatchError: (
					_error: unknown,
					_record: unknown,
					assessment?: unknown,
				) => assessments.push(assessment),
			},
		};
		const dispatcher = fastDispatcher(options);
		await runUntil(dispatcher, () => eventually(() => delivered.length === 1));

		// The safe default under a broken classifier: the failure counted,
		// the poison record dead-lettered, the successor flowed.
		expect(delivered).toEqual([2]);
		expect(await outbox.deadLetters()).toHaveLength(1);
		expect(assessments[0]).toMatchObject({
			kind: "unknown",
			classifierError,
		});
	});

	it("reports a failed ack once per record of the delivered prefix", async () => {
		const inner = new InMemoryOutbox<TestEvent>();
		await inner.add([makeCommitted(1), makeCommitted(2), makeCommitted(3)]);
		let failAcks = 1;
		const outbox = interceptOutbox(inner, {
			markDispatched: async (ids) => {
				if (failAcks > 0) {
					failAcks--;
					throw new Error("ack failed");
				}
				return inner.markDispatched(ids);
			},
		});
		const reported: string[] = [];
		const delivered: number[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({
			outbox,
			sink,
			observers: {
				onDispatchError: (_error, record) =>
					reported.push(record.event.eventId),
			},
		});
		await runUntil(dispatcher, () => eventually(() => delivered.length >= 6));

		// Every record of the delivered prefix redelivers; each one gets its
		// own report, so the duplicates are traceable to the ack failure.
		expect(reported).toEqual(["evt-1", "evt-2", "evt-3"]);
	});

	it("does not mistake a plain outbox with an unrelated markFailed helper for a tracking outbox", async () => {
		const inner = new InMemoryOutbox<TestEvent>();
		await inner.add([makeCommitted(1), makeCommitted(2)]);
		const helperCalls: unknown[] = [];
		// Structurally an Outbox, plus a markFailed that is NOT the tracking
		// protocol (no deadLetters); the dispatcher must never call it.
		const outbox: Outbox<TestEvent> & {
			markFailed: (reason: string) => Promise<void>;
		} = {
			add: (events) => inner.add(events),
			getPending: (limit) => inner.getPending(limit),
			markDispatched: (ids) => inner.markDispatched(ids),
			markFailed: async (reason) => {
				helperCalls.push(reason);
			},
		};
		const delivered: number[] = [];
		let poisonAttempts = 0;
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				if (record.event.payload.n === 1 && poisonAttempts < 2) {
					poisonAttempts++;
					throw new Error("poison");
				}
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({ outbox, sink });
		// The wiring-test assertion the option docs recommend: tracking is
		// structurally OFF for this outbox, visible before anything runs.
		expect(dispatcher.usesDispatchTracking).toBe(false);
		await runUntil(dispatcher, () => eventually(() => delivered.length === 2));

		expect(delivered).toEqual([1, 2]);
		expect(helperCalls).toEqual([]);
	});

	it("exposes active dispatch tracking via usesDispatchTracking", () => {
		const sink: OutboxSink<TestEvent> = { publish: async () => {} };
		const tracking = fastDispatcher({
			outbox: new InMemoryOutbox<TestEvent>(),
			sink,
		});
		expect(tracking.usesDispatchTracking).toBe(true);

		const plain = fastDispatcher({
			outbox: interceptOutbox(new InMemoryOutbox<TestEvent>(), {}),
			sink,
		});
		expect(plain.usesDispatchTracking).toBe(false);
	});

	it("a throwing onDispatchError observer cannot break the loop", async () => {
		const outbox = new InMemoryOutbox<TestEvent>({ maxDeliveryAttempts: 1 });
		await outbox.add([makeCommitted(1), makeCommitted(2)]);
		const delivered: number[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				if (record.event.payload.n === 1) throw new Error("poison");
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({
			outbox,
			sink,
			observers: {
				onDispatchError: () => {
					throw new Error("observer bug");
				},
			},
		});
		await runUntil(dispatcher, () => eventually(() => delivered.length === 1));

		expect(delivered).toEqual([2]);
	});

	it("drains a backlog larger than the batch size", async () => {
		const outbox = new InMemoryOutbox<TestEvent>();
		await outbox.add(Array.from({ length: 10 }, (_, i) => makeCommitted(i)));
		const delivered: number[] = [];
		const sink: OutboxSink<TestEvent> = {
			publish: async (record) => {
				delivered.push(record.event.payload.n);
			},
		};

		const dispatcher = fastDispatcher({ outbox, sink, batchSize: 3 });
		await runUntil(dispatcher, () => eventually(() => delivered.length === 10));

		expect(delivered).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("resolves promptly on abort while idle", async () => {
		const outbox = new InMemoryOutbox<TestEvent>();
		const sink: OutboxSink<TestEvent> = { publish: async () => {} };
		const dispatcher = new OutboxDispatcher({
			outbox,
			sink,
			pollIntervalMs: 60_000, // would hang without abortable sleep
			observers: {
				onDispatchError: () => {},
				onPollError: () => {},
				onDeadLetter: () => {},
			},
		});

		const stop = new AbortController();
		const loop = dispatcher.run(stop.signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		stop.abort();
		await expect(loop).resolves.toBeUndefined();
	});

	it("validates numeric options at construction", () => {
		const outbox = new InMemoryOutbox<TestEvent>();
		const sink: OutboxSink<TestEvent> = { publish: async () => {} };
		expect(() => fastDispatcher({ outbox, sink, batchSize: 0 })).toThrow(
			"batchSize",
		);
		expect(() => fastDispatcher({ outbox, sink, pollIntervalMs: -1 })).toThrow(
			"pollIntervalMs",
		);
		expect(() =>
			fastDispatcher({ outbox, sink, baseDelayMs: Number.NaN }),
		).toThrow("baseDelayMs");
		expect(() =>
			fastDispatcher({ outbox, sink, deliveryTimeoutMs: -1 }),
		).toThrow("deliveryTimeoutMs");
		expect(() =>
			fastDispatcher({ outbox, sink, storageTimeoutMs: Number.NaN }),
		).toThrow("storageTimeoutMs");
	});

	describe("drainOnce", () => {
		it("dispatches the whole backlog in one pass and reports drained", async () => {
			const outbox = new InMemoryOutbox<TestEvent>();
			await outbox.add(Array.from({ length: 7 }, (_, i) => makeCommitted(i)));
			const delivered: number[] = [];
			const sink: OutboxSink<TestEvent> = {
				publish: async (record) => {
					delivered.push(record.event.payload.n);
				},
			};

			const dispatcher = fastDispatcher({ outbox, sink, batchSize: 3 });
			await expect(dispatcher.drainOnce()).resolves.toBe("drained");

			expect(delivered).toEqual([0, 1, 2, 3, 4, 5, 6]);
			expect(await outbox.getPending()).toHaveLength(0);
		});

		it("returns stopped on a failure, leaving the failed record for the next tick", async () => {
			const outbox = new InMemoryOutbox<TestEvent>({
				maxDeliveryAttempts: 99,
			});
			await outbox.add([makeCommitted(1), makeCommitted(2)]);
			let fail = true;
			const sink: OutboxSink<TestEvent> = {
				publish: async (record) => {
					if (record.event.payload.n === 2 && fail) {
						throw new Error("transient");
					}
				},
			};

			const dispatcher = fastDispatcher({ outbox, sink });
			await expect(dispatcher.drainOnce()).resolves.toBe("stopped");
			expect(await outbox.getPending()).toHaveLength(1);

			// Next tick succeeds.
			fail = false;
			await expect(dispatcher.drainOnce()).resolves.toBe("drained");
			expect(await outbox.getPending()).toHaveLength(0);
		});

		it("never rejects on a poll failure", async () => {
			const outbox: Outbox<TestEvent> = {
				add: async () => {},
				getPending: async () => {
					throw new Error("storage down");
				},
				markDispatched: async () => {},
			};
			const sink: OutboxSink<TestEvent> = { publish: async () => {} };
			const pollErrors: unknown[] = [];

			const dispatcher = fastDispatcher({
				outbox,
				sink,
				observers: {
					onPollError: (error) => {
						pollErrors.push(error);
					},
				},
			});
			await expect(dispatcher.drainOnce()).resolves.toBe("stopped");
			expect(pollErrors).toHaveLength(1);
		});
	});
});

describe("eventBusSink", () => {
	it("delivers through the in-process bus and propagates handler failures", async () => {
		const bus = new EventBusImpl<TestEvent>();
		const seen: number[] = [];
		bus.subscribe("ThingHappened", (event) => {
			if (event.payload.n === 99) throw new Error("handler failed");
			seen.push(event.payload.n);
		});
		const sink = eventBusSink<TestEvent>(bus);
		const context = {
			signal: new AbortController().signal,
			deadlineAt: Date.now() + 1_000,
		};

		const ok = makeEvent(7);
		const okMessage = makeCommitted(7);
		const okRecord: OutboxRecord<TestEvent> = {
			dispatchId: ok.eventId,
			event: ok,
			source: okMessage.source,
			position: okMessage.position,
		};
		await sink.publish(okRecord, context);
		expect(seen).toEqual([7]);

		const bad = makeEvent(99);
		const badMessage = makeCommitted(99);
		await expect(
			sink.publish(
				{
					dispatchId: bad.eventId,
					event: bad,
					source: badMessage.source,
					position: badMessage.position,
				},
				context,
			),
		).rejects.toThrow("handler failed");
	});
});
