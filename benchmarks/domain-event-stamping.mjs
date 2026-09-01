import { performance } from "node:perf_hooks";
import process from "node:process";
import {
	createDomainEventFactory,
	createUncommittedDomainEvent,
	recordDomainEvent,
} from "../dist/index.js";

if (typeof global.gc !== "function") {
	throw new Error(
		"Run with --expose-gc so retained heap measurements are comparable",
	);
}

const fixedTime = new Date("2027-04-05T06:07:08.000Z");
let eventSequence = 0;
const factory = createDomainEventFactory({
	eventIdFactory: () => `event-${++eventSequence}`,
	clock: () => fixedTime,
});

const scenarios = [
	{
		name: "small",
		iterations: 40_000,
		payload: { orderId: "order-1" },
		metadata: { correlationId: "correlation-1" },
	},
	{
		name: "medium",
		iterations: 12_000,
		payload: {
			orderId: "order-1",
			lines: Array.from({ length: 12 }, (_, index) => ({
				sku: `sku-${index}`,
				quantity: index + 1,
				unitMinor: 1_999 + index,
			})),
		},
		metadata: {
			correlationId: "correlation-1",
			actor: { id: "user-1", roles: ["buyer", "member"] },
			trace: { region: "eu-central-1", attempt: 1 },
		},
	},
	{
		name: "deep",
		iterations: 4_000,
		payload: {
			orderId: "order-1",
			details: nestedRecord(7),
		},
		metadata: {
			correlationId: "correlation-1",
			context: nestedRecord(6),
		},
	},
];

function nestedRecord(depth) {
	let value = { leaf: "value" };
	for (let level = 0; level < depth; level += 1) {
		value = { level, child: value, tags: [`tag-${level}`, "benchmark"] };
	}
	return value;
}

function recordWithFactory(payload, metadata) {
	const decision = createUncommittedDomainEvent("BenchmarkEvent", payload, {
		aggregateId: "aggregate-1",
		aggregateType: "BenchmarkAggregate",
		schemaVersion: 2,
	});
	return recordDomainEvent(decision, factory.createStamp({ metadata }));
}

function recordWithHandBuiltStamp(payload, metadata) {
	const decision = createUncommittedDomainEvent("BenchmarkEvent", payload, {
		aggregateId: "aggregate-1",
		aggregateType: "BenchmarkAggregate",
		schemaVersion: 2,
	});
	return recordDomainEvent(decision, {
		eventId: `event-${++eventSequence}`,
		occurredAt: fixedTime,
		metadata,
	});
}

function measure(name, iterations, operation, payload, metadata) {
	for (let index = 0; index < Math.min(iterations, 2_000); index += 1) {
		operation(payload, metadata);
	}
	global.gc();
	const heapBefore = process.memoryUsage().heapUsed;
	const startedAt = performance.now();
	const retained = new Array(iterations);
	let checksum = 0;
	for (let index = 0; index < iterations; index += 1) {
		const event = operation(payload, metadata);
		retained[index] = event;
		checksum += event.eventId.length + event.schemaVersion;
	}
	const elapsedMs = performance.now() - startedAt;
	global.gc();
	const heapAfter = process.memoryUsage().heapUsed;
	// Read retained values after the forced collection so V8's liveness
	// analysis cannot prove the array dead before the heap sample.
	checksum +=
		retained[0].eventId.length + retained[retained.length - 1].eventId.length;
	return {
		name,
		iterations,
		operationsPerSecond: Math.round(iterations / (elapsedMs / 1_000)),
		retainedBytesPerEvent: Math.max(
			0,
			Math.round((heapAfter - heapBefore) / iterations),
		),
		checksum,
	};
}

const results = [];
for (const scenario of scenarios) {
	results.push(
		measure(
			`${scenario.name}/factory-stamp`,
			scenario.iterations,
			recordWithFactory,
			scenario.payload,
			scenario.metadata,
		),
	);
	results.push(
		measure(
			`${scenario.name}/hand-built-stamp`,
			scenario.iterations,
			recordWithHandBuiltStamp,
			scenario.payload,
			scenario.metadata,
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
					"Warm process throughput for decision creation plus recording",
				retainedBytesPerEvent:
					"Heap delta after forced GC while retaining every final event; transient allocations are reflected in throughput, not this number",
			},
			results,
		},
		null,
		2,
	),
);
