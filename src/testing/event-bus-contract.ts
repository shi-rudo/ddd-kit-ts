import type { AnyDomainEvent } from "../domain/event/domain-event";
import type { EventBus } from "../messaging/event-bus/ports";
import {
	assert,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
	captureRejection,
} from "./contract-assertions";

/** One entry of the event-bus contract suite. */
export type EventBusContractTest = ContractTest;

/**
 * What the suite runs against. The harness creates one per test and tears
 * it down afterwards. No transaction wrapper: the port is in-process and
 * transaction-free by design.
 */
export interface EventBusContractEnvironment<Evt extends AnyDomainEvent> {
	/** The implementation under test. */
	readonly bus: EventBus<Evt>;

	/** Release connections, drop schemas, etc. Called in a finally. */
	teardown?(): Promise<void>;
}

/**
 * What an implementation supplies to run the event-bus contract suite.
 *
 * The suite mints no events, so it stays free of any event union. The two
 * factories must produce DIFFERENT `type` values: the suite subscribes to
 * both to prove that ordering holds across types and that a catch-all
 * subscription sees every type.
 */
export interface EventBusContractHarness<Evt extends AnyDomainEvent> {
	createEnvironment(): Promise<EventBusContractEnvironment<Evt>>;
	/** An event of the first type. Called repeatedly; each call may differ. */
	createFirstEvent(): Evt;
	/** An event of the second type, whose `type` differs from the first. */
	createSecondEvent(): Evt;
}

/** Resolves after enough turns for a parallel batch to have started. */
function turn(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The event-bus contract test suite: the proof that an implementation
 * delivers the guarantees the `EventBus` port documents. Ordering,
 * parallelism within one event, and error collection after the batch are
 * a **port contract, not a kit guarantee**; this suite is how an
 * implementation demonstrates them.
 *
 * The suite covers the port and nothing else. Construction options of the
 * kit's own adapter, such as a publish-depth bound or an observer bundle,
 * are not port behavior and are not pinned here.
 *
 * Framework-agnostic: bind with
 * `(test.skipped ? it.skip : it)(test.name, test.run)`.
 */
export function createEventBusContractTests<Evt extends AnyDomainEvent>(
	harness: EventBusContractHarness<Evt>,
): EventBusContractTest[] {
	type Env = EventBusContractEnvironment<Evt>;
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());

	const first = () => harness.createFirstEvent();
	const second = () => harness.createSecondEvent();
	// Called inside a test, never while the suite is built. A harness whose
	// factories need their environment would otherwise throw before a single
	// test has a name.
	const types = () => {
		const firstType = first().type as Evt["type"];
		const secondType = second().type as Evt["type"];
		assert(
			firstType !== secondType,
			"the harness must supply two event factories with different types",
		);
		return { firstType, secondType };
	};

	return [
		{
			name: "dispatches the events of one batch in input order",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType, secondType } = types();
				const seen: string[] = [];
				// The first type is the slower one. Input order must hold
				// whatever the handlers cost, so a dispatch that runs the batch
				// concurrently reorders here and fails.
				bus.subscribe(firstType, async (event) => {
					await new Promise((resolve) => setTimeout(resolve, 20));
					seen.push(event.type);
				});
				bus.subscribe(secondType, async (event) => {
					seen.push(event.type);
				});

				await bus.publish([first(), second(), first()]);

				assertEqual(
					seen.join(","),
					[firstType, secondType, firstType].join(","),
					"a batch dispatches its events in input order",
				);
			}),
		},
		{
			name: "starts the handlers of an event only after the previous event finished",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType, secondType } = types();
				const trace: string[] = [];
				bus.subscribe(firstType, async () => {
					trace.push("first:start");
					await turn();
					trace.push("first:end");
				});
				bus.subscribe(secondType, async () => {
					trace.push("second:start");
				});

				await bus.publish([first(), second()]);

				assertEqual(
					trace.join(","),
					"first:start,first:end,second:start",
					"an event dispatches only after the previous one finished",
				);
			}),
		},
		{
			name: "runs the handlers of one event in parallel",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const trace: string[] = [];
				bus.subscribe(firstType, async () => {
					trace.push("a:start");
					await turn();
					trace.push("a:end");
				});
				bus.subscribe(firstType, async () => {
					trace.push("b:start");
					await turn();
					trace.push("b:end");
				});

				await bus.publish([first()]);

				// Sequential dispatch would read a:start, a:end, b:start, b:end.
				assertEqual(
					trace.join(","),
					"a:start,b:start,a:end,b:end",
					"the handlers of one event run in parallel",
				);
			}),
		},
		{
			name: "runs every handler of an event when a peer fails",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const seen: string[] = [];
				bus.subscribe(firstType, async () => {
					throw new Error("first handler failed");
				});
				bus.subscribe(firstType, async () => {
					seen.push("peer");
				});

				await captureRejection(bus.publish([first()]));

				assertEqual(
					seen.join(","),
					"peer",
					"a peer of a failing handler still runs",
				);
			}),
		},
		{
			name: "reaches the caller with a single failure directly",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const failure = new Error("the only handler failed");
				bus.subscribe(firstType, async () => {
					throw failure;
				});

				const thrown = await captureRejection(bus.publish([first()]));

				assertEqual(
					thrown,
					failure,
					"a single failure reaches the caller unchanged",
				);
			}),
		},
		{
			name: "collects two or more failures into an AggregateError",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const one = new Error("handler one failed");
				const two = new Error("handler two failed");
				bus.subscribe(firstType, async () => {
					throw one;
				});
				bus.subscribe(firstType, async () => {
					throw two;
				});

				const thrown = await captureRejection(bus.publish([first()]));

				assert(
					thrown instanceof AggregateError,
					"two failures must reach the caller as an AggregateError",
				);
				// The port promises that every failure is carried, not the order
				// they are carried in. Ordering is an implementation choice.
				assertEqual(
					thrown.errors.length,
					2,
					"the AggregateError carries every failure",
				);
				assert(
					thrown.errors.includes(one) && thrown.errors.includes(two),
					"the AggregateError carries both failures",
				);
			}),
		},
		{
			name: "publishes the remaining events of a batch after a failure",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType, secondType } = types();
				const seen: string[] = [];
				bus.subscribe(firstType, async () => {
					throw new Error("first handler failed");
				});
				bus.subscribe(secondType, async (event) => {
					seen.push(event.type);
				});

				await captureRejection(bus.publish([first(), second()]));

				assertEqual(
					seen.join(","),
					secondType,
					"a failure does not stop the remaining events of the batch",
				);
			}),
		},
		{
			name: "treats a handler that throws synchronously as a rejection",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const seen: string[] = [];
				bus.subscribe(firstType, () => {
					throw new Error("thrown synchronously");
				});
				bus.subscribe(firstType, async () => {
					seen.push("peer");
				});

				const thrown = await captureRejection(bus.publish([first()]));

				assert(thrown instanceof Error, "the throw must reach the caller");
				assertEqual(
					seen.join(","),
					"peer",
					"a synchronous throw does not skip the peers",
				);
			}),
		},
		{
			name: "hands every subscriber the same event object",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const received: unknown[] = [];
				bus.subscribe(firstType, (event) => {
					received.push(event);
				});
				bus.subscribeAll((event) => {
					received.push(event);
				});

				const published = first();
				await bus.publish([published]);

				assertEqual(
					received.length,
					2,
					"both subscriptions must receive the event",
				);
				for (const one of received) {
					assert(
						one === published,
						"every subscriber receives the published event itself, so its metadata cannot differ between them",
					);
				}
			}),
		},
		{
			name: "delivers every type of a subscribed set to one handler",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType, secondType } = types();
				const seen: string[] = [];
				bus.subscribeMany([firstType, secondType], (event) => {
					seen.push(event.type);
				});

				await bus.publish([first(), second()]);

				assertEqual(
					seen.join(","),
					[firstType, secondType].join(","),
					"a set subscription receives every type in the set",
				);
			}),
		},
		{
			name: "releases every subscription of a set with one call",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType, secondType } = types();
				const seen: string[] = [];
				const release = bus.subscribeMany([firstType, secondType], (event) => {
					seen.push(event.type);
				});

				release();
				await bus.publish([first(), second()]);

				assertEqual(
					seen.length,
					0,
					"one release must remove every subscription the set made",
				);
			}),
		},
		{
			name: "subscribes a repeated type of a set once",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				let calls = 0;
				bus.subscribeMany([firstType, firstType], () => {
					calls++;
				});

				await bus.publish([first()]);

				assertEqual(
					calls,
					1,
					"the argument is a set, so a repeated type subscribes once",
				);
			}),
		},
		{
			name: "delivers every event type to a catch-all subscription",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType, secondType } = types();
				const seen: string[] = [];
				bus.subscribeAll(async (event) => {
					seen.push(event.type);
				});

				await bus.publish([first(), second()]);

				assertEqual(
					seen.join(","),
					[firstType, secondType].join(","),
					"a catch-all subscription receives every event type",
				);
			}),
		},
		{
			name: "runs a catch-all handler in the same batch as the typed handlers",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const seen: string[] = [];
				bus.subscribe(firstType, async () => {
					throw new Error("typed handler failed");
				});
				bus.subscribeAll(async () => {
					seen.push("catch-all");
				});

				await captureRejection(bus.publish([first()]));

				assertEqual(
					seen.join(","),
					"catch-all",
					"a catch-all handler runs in the same batch as the typed ones",
				);
			}),
		},
		{
			name: "removes exactly one subscription when the same handler subscribed twice",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				let calls = 0;
				const handler = async () => {
					calls++;
				};
				const release = bus.subscribe(firstType, handler);
				bus.subscribe(firstType, handler);

				release();
				await bus.publish([first()]);

				assertEqual(
					calls,
					1,
					"unsubscribe removes exactly one of two identical subscriptions",
				);
			}),
		},
		{
			name: "ignores a second call of the unsubscribe function",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				let calls = 0;
				const release = bus.subscribe(firstType, async () => {
					calls++;
				});
				bus.subscribe(firstType, async () => {
					calls++;
				});

				release();
				release();
				await bus.publish([first()]);

				assertEqual(
					calls,
					1,
					"a second unsubscribe removes no further subscription",
				);
			}),
		},
		{
			name: "resolves once() with the next event of its type and stops after it",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				let deliveries = 0;
				bus.subscribeAll(async () => {
					deliveries++;
				});
				const waiting = bus.once(firstType);

				const announced = first();
				await bus.publish([announced]);
				const received = await waiting;
				await bus.publish([first()]);

				assertEqual(
					received.eventId,
					announced.eventId,
					"once() resolves with the first event of that type",
				);
				// The catch-all proves the second publication happened, so the
				// subscription of once() is gone rather than never reached.
				assertEqual(
					deliveries,
					2,
					"the second publication must still reach the bus",
				);
			}),
		},
		{
			name: "rejects once() when its timeout expires",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const thrown = await captureRejection(
					bus.once(firstType, { timeoutMs: 5 }),
				);

				assert(thrown !== undefined, "once() must reject after its timeout");
			}),
		},
		{
			name: "rejects once() with the reason of an aborted signal",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const controller = new AbortController();
				const reason = new Error("the caller stopped waiting");
				const waiting = captureRejection(
					bus.once(firstType, { signal: controller.signal }),
				);

				controller.abort(reason);

				assertEqual(
					await waiting,
					reason,
					"once() rejects with the reason of the signal",
				);
			}),
		},
		{
			name: "rejects a publication whose signal is already aborted",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				const controller = new AbortController();
				controller.abort(new Error("stopped before publish"));
				let called = false;
				bus.subscribe(firstType, async () => {
					called = true;
				});

				const thrown = await captureRejection(
					bus.publish([first()], { signal: controller.signal }),
				);

				assert(thrown !== undefined, "an aborted publication must reject");
				assertEqual(
					called,
					false,
					"an aborted publication dispatches no handler",
				);
			}),
		},
		{
			name: "refuses every operation after close",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				bus.close();

				let subscribeThrew = false;
				try {
					bus.subscribe(firstType, () => {});
				} catch {
					subscribeThrew = true;
				}
				let subscribeAllThrew = false;
				try {
					bus.subscribeAll(() => {});
				} catch {
					subscribeAllThrew = true;
				}

				assert(subscribeThrew, "subscribe must refuse a closed bus");
				assert(subscribeAllThrew, "subscribeAll must refuse a closed bus");
				assert(
					(await captureRejection(bus.publish([first()]))) !== undefined,
					"publish must refuse a closed bus",
				);
				assert(
					(await captureRejection(bus.once(firstType))) !== undefined,
					"once must refuse a closed bus",
				);
			}),
		},
		{
			name: "settles a pending once() when the bus closes",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				// Without a timeout and without a signal this waiter has no
				// other way to end.
				const waiting = captureRejection(bus.once(firstType));

				bus.close();

				assert(
					(await waiting) !== undefined,
					"closing must settle a pending once()",
				);
			}),
		},
		{
			name: "does nothing when close is called again",
			run: inEnv(async ({ bus }: Env) => {
				bus.close();

				let threw = false;
				try {
					bus.close();
				} catch {
					threw = true;
				}

				assert(threw === false, "a second close must do nothing");
			}),
		},
		{
			name: "bounds the wait, not the handler, when the timeout expires",
			run: inEnv(async ({ bus }: Env) => {
				const { firstType } = types();
				let running = true;
				bus.subscribe(firstType, async () => {
					await new Promise((resolve) => setTimeout(resolve, 200));
					running = false;
				});

				const thrown = await captureRejection(
					bus.publish([first()], { timeoutMs: 10 }),
				);

				assert(thrown !== undefined, "the publication must reject");
				assertEqual(
					running,
					true,
					"the timeout bounds the wait, so the handler keeps running",
				);
			}),
		},
	];
}
