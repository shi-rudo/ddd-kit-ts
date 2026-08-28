import { performance } from "node:perf_hooks";
import process from "node:process";
import {
	AggregateRoot,
	createDomainEvent,
	EventSourcedAggregate,
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

class StateStoredOrder extends AggregateRoot {
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
	handlers = {
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

// The shell reads the pendingEvents getter twice per commit (enrollment
// and harvest); the benchmark reads it the same number of times.
function shellReads(aggregate) {
	return aggregate.pendingEvents.length + aggregate.pendingEvents.length;
}

function measure(name, iterations, setup, operation) {
	let context = setup();
	for (let index = 0; index < Math.min(iterations, 1_000); index += 1) {
		context = operation(context, index) ?? context;
	}
	global.gc();
	context = setup();
	const heapBefore = process.memoryUsage().heapUsed;
	const startedAt = performance.now();
	let checksum = 0;
	for (let index = 0; index < iterations; index += 1) {
		const next = operation(context, index);
		if (next !== undefined) context = next;
		checksum += 1;
	}
	const elapsedMs = performance.now() - startedAt;
	global.gc();
	const heapAfter = process.memoryUsage().heapUsed;
	checksum += context.version;
	return {
		name,
		iterations,
		operationsPerSecond: Math.round(iterations / (elapsedMs / 1_000)),
		retainedBytesPerOperation: Math.max(
			0,
			Math.round((heapAfter - heapBefore) / iterations),
		),
		checksum,
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
		name: "state-stored/setState-with-event/shallow",
		iterations: 20_000,
		setup: () => new StateStoredOrder("order-1", nestedState(12, 4)),
		operation: (order, index) => {
			order.touch(index);
			shellReads(order);
		},
	},
	{
		name: "state-stored/setState-with-event/deep",
		iterations: 20_000,
		setup: () =>
			new StateStoredOrder("order-1", nestedState(12, 4), {
				deepFreezeState: true,
			}),
		operation: (order, index) => {
			order.touch(index);
			shellReads(order);
		},
	},
	{
		name: "event-sourced/apply/shallow",
		iterations: 20_000,
		setup: () => new EventSourcedOrder("order-1", nestedState(12, 4)),
		operation: (order, index) => {
			order.touch(index);
			shellReads(order);
		},
	},
	{
		name: "event-sourced/apply/deep",
		iterations: 20_000,
		setup: () =>
			new EventSourcedOrder("order-1", nestedState(12, 4), {
				deepFreezeState: true,
			}),
		operation: (order, index) => {
			order.touch(index);
			shellReads(order);
		},
	},
	{
		name: "event-sourced/replayHistory-2000/shallow",
		iterations: 40,
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
		iterations: 40,
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

const results = scenarios.map((scenario) =>
	measure(
		scenario.name,
		scenario.iterations,
		scenario.setup,
		scenario.operation,
	),
);

console.log(
	JSON.stringify(
		{
			runtime: process.version,
			platform: `${process.platform}/${process.arch}`,
			metricNotes: {
				operationsPerSecond:
					"Warm process throughput: one aggregate write plus the shell's two pendingEvents reads, or one full replay",
				retainedBytesPerOperation:
					"Heap delta after forced GC per operation; the pending list grows with every write, so writes retain by design",
			},
			results,
		},
		null,
		2,
	),
);
