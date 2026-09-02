import { performance } from "node:perf_hooks";
import process from "node:process";
import {
	createDomainEvent,
	createDomainEventFactory,
	EventSourcedAggregate,
	recordPendingEvents,
	StateStoredAggregate,
	withCommit,
} from "../dist/index.js";

if (typeof global.gc !== "function") {
	throw new Error(
		"Run with --expose-gc so retained heap measurements are comparable",
	);
}

function nestedState(width, depth) {
	const lines = Array.from({ length: width }, (_, index) => ({
		sku: `sku-${index}`,
		quantity: index + 1,
		attributes: nestedRecord(depth),
	}));
	return { status: "open", lines, totals: { minor: 0, currency: "EUR" } };
}

function nestedRecord(depth) {
	let value = { leaf: "value" };
	for (let level = 0; level < depth; level += 1) {
		value = { level, child: value, tags: [`tag-${level}`, "benchmark"] };
	}
	return value;
}

class StateStoredOrder extends StateStoredAggregate {
	aggregateType = "BenchmarkOrder";

	constructor(id, state, config) {
		super(id, state, config);
	}

	touch(sequence) {
		this.setState(
			{ ...this.state, status: `status-${sequence}` },
			this.createEvent("OrderTouched", { sequence }),
		);
	}
}

class EventSourcedOrder extends EventSourcedAggregate {
	aggregateType = "BenchmarkEsOrder";
	folds = {
		OrderTouched: (state, event) => ({
			...state,
			status: `status-${event.payload.sequence}`,
		}),
	};

	constructor(id, state, config) {
		super(id, state, config);
	}

	touch(sequence) {
		this.apply(this.createEvent("OrderTouched", { sequence }));
	}
}

const fixedTime = new Date("2027-04-05T06:07:08.000Z");
let eventSequence = 0;
const factory = createDomainEventFactory({
	eventIdFactory: () => `event-${++eventSequence}`,
	clock: () => fixedTime,
});

// The shell path of one commit, in memory: the domain method records a
// decision, the shell stamps it, withCommit enrolls the aggregate,
// harvests the event into the outbox, and acknowledges it. The outbox and
// the transaction scope cost nothing, so the number is the kit's own cost.
const outbox = {
	add: async () => {},
	getPending: async () => [],
	markDispatched: async () => {},
};
const scope = {
	transactional: (fn) => fn(undefined),
};

async function commitOne(order, sequence) {
	order.touch(sequence);
	await withCommit({ outbox, scope }, async (_ctx, enrollment) => {
		recordPendingEvents(order, factory);
		return { result: undefined, commits: [enrollment.enrollSaved(order)] };
	});
}

async function measure(name, iterations, setup, operation) {
	let context = setup();
	for (let index = 0; index < Math.min(iterations, 1_000); index += 1) {
		context = (await operation(context, index)) ?? context;
	}
	global.gc();
	context = setup();
	const heapBefore = process.memoryUsage().heapUsed;
	const startedAt = performance.now();
	for (let index = 0; index < iterations; index += 1) {
		const next = await operation(context, index);
		if (next !== undefined) context = next;
	}
	const elapsedMs = performance.now() - startedAt;
	global.gc();
	const heapAfter = process.memoryUsage().heapUsed;
	return {
		name,
		iterations,
		operationsPerSecond: Math.round(iterations / (elapsedMs / 1_000)),
		microsecondsPerOperation:
			Math.round(((elapsedMs * 1_000) / iterations) * 100) / 100,
		retainedBytesPerOperation: Math.max(
			0,
			Math.round((heapAfter - heapBefore) / iterations),
		),
		version: context.version,
	};
}

const freshHistory = (count) =>
	Array.from({ length: count }, (_, sequence) =>
		createDomainEvent(
			"OrderTouched",
			{ sequence },
			{ aggregateId: "order-1", aggregateType: "BenchmarkEsOrder" },
		),
	);

const scenarios = [
	{
		name: "state-stored/commit/shallow",
		iterations: 20_000,
		setup: () => new StateStoredOrder("order-1", nestedState(12, 4)),
		operation: commitOne,
	},
	{
		name: "state-stored/commit/deep",
		iterations: 20_000,
		setup: () =>
			new StateStoredOrder("order-1", nestedState(12, 4), {
				deepFreezeState: true,
			}),
		operation: commitOne,
	},
	{
		name: "event-sourced/commit/shallow",
		iterations: 20_000,
		setup: () => new EventSourcedOrder("order-1", nestedState(12, 4)),
		operation: commitOne,
	},
	{
		name: "event-sourced/commit/deep",
		iterations: 20_000,
		setup: () =>
			new EventSourcedOrder("order-1", nestedState(12, 4), {
				deepFreezeState: true,
			}),
		operation: commitOne,
	},
	{
		name: "event-sourced/replayHistory-2000/shallow",
		iterations: 100,
		setup: () => freshHistory(2_000),
		operation: (history) => {
			const order = new EventSourcedOrder("order-1", nestedState(12, 4));
			const result = order.replayHistory(history);
			if (result.isErr()) throw result.error;
			return history;
		},
	},
	{
		name: "event-sourced/replayHistory-2000/deep",
		iterations: 100,
		setup: () => freshHistory(2_000),
		operation: (history) => {
			const order = new EventSourcedOrder("order-1", nestedState(12, 4), {
				deepFreezeState: true,
			});
			const result = order.replayHistory(history);
			if (result.isErr()) throw result.error;
			return history;
		},
	},
];

const results = [];
for (const scenario of scenarios) {
	results.push(
		await measure(
			scenario.name,
			scenario.iterations,
			scenario.setup,
			scenario.operation,
		),
	);
}

console.log(
	JSON.stringify(
		{
			runtime: process.version,
			platform: `${process.platform}/${process.arch}`,
			metricNotes: {
				operationsPerSecond:
					"Warm process throughput: one full in-memory commit (domain method, recordPendingEvents, withCommit enrollment, harvest, acknowledgement), or one full replay",
				microsecondsPerOperation: "Wall time per operation",
				retainedBytesPerOperation:
					"Heap delta after forced GC per operation; a commit leaves nothing pending, so a positive value is a leak",
			},
			results,
		},
		null,
		2,
	),
);
