import type { AggregateAddress } from "../domain/aggregate/aggregate-address";
import type { AnyDomainEvent } from "../domain/event/domain-event";
import type { ReplayableStreamPages } from "../persistence/event-store/reconstitute-from-stream-pages";
import {
	assert,
	bindContractEnvironment,
	type ContractTest,
} from "./contract-assertions";

/** One named contract test for code that builds replayable stream reads. */
export type ReplayableStreamPagesContractTest = ContractTest;

/** The window the suite asks the code under test for. */
export interface ReplayableStreamPagesContractWindow {
	/** The cursor: the pages hold the events after this version. */
	readonly fromVersion: number;
	/** The version a point-in-time read asks for. Absent for a read to the head. */
	readonly toVersion?: number;
	/** The maximum number of events per page. */
	readonly limit: number;
}

/** The code under test and the store it reads. The suite creates one per test. */
export interface ReplayableStreamPagesContractEnvironment<
	Evt extends AnyDomainEvent,
> {
	/** Appends events to the end of the stream in the store that the code reads. */
	append(stream: AggregateAddress, events: ReadonlyArray<Evt>): Promise<void>;

	/**
	 * Reads the stream through the code under test. Returns `undefined`
	 * for an absent stream and for a window that lies outside the stream.
	 */
	read(
		stream: AggregateAddress,
		window: ReplayableStreamPagesContractWindow,
	): Promise<ReplayableStreamPages<Evt> | undefined>;

	teardown?(): Promise<void>;
}

/**
 * Inputs the suite needs. `createStream` returns a stream address that no
 * other test uses. `createEvent` returns an event addressed to that
 * stream; different sequence values give different event ids.
 */
export interface ReplayableStreamPagesContractHarness<
	Evt extends AnyDomainEvent,
> {
	createEnvironment(): Promise<ReplayableStreamPagesContractEnvironment<Evt>>;
	createStream(): AggregateAddress;
	createEvent(stream: AggregateAddress, sequence: number): Evt;
}

/**
 * Reusable proof of code that builds `ReplayableStreamPages` values:
 * `readStreamPages`, or an adapter that pages on its own.
 * The suite proves that the pages hold the events after the cursor
 * through the target version in append order, that no page is empty or
 * larger than the limit, that every iteration yields the same prefix, and
 * that an append during the iteration stays out. It also proves that an
 * absent stream and a window outside the stream give no replayable read.
 */
export function createReplayableStreamPagesContractTests<
	Evt extends AnyDomainEvent,
>(
	harness: ReplayableStreamPagesContractHarness<Evt>,
): ReplayableStreamPagesContractTest[] {
	const inEnv = bindContractEnvironment(() => harness.createEnvironment());
	const seed = async (
		env: ReplayableStreamPagesContractEnvironment<Evt>,
		count: number,
	): Promise<{ stream: AggregateAddress; events: Evt[] }> => {
		const stream = harness.createStream();
		const events = Array.from({ length: count }, (_, index) =>
			harness.createEvent(stream, index + 1),
		);
		await env.append(stream, events);
		return { stream, events };
	};
	const readOrFail = async (
		env: ReplayableStreamPagesContractEnvironment<Evt>,
		stream: AggregateAddress,
		window: ReplayableStreamPagesContractWindow,
	): Promise<ReplayableStreamPages<Evt>> => {
		const read = await env.read({ ...stream }, window);
		assert(
			read !== undefined,
			`a window (${window.fromVersion}, ${window.toVersion ?? "head"}] inside the stream must give a replayable read`,
		);
		return read;
	};
	const collectPages = async (
		read: ReplayableStreamPages<Evt>,
		limit: number,
	): Promise<Evt[]> => {
		const collected: Evt[] = [];
		for await (const page of read.pages) {
			assert(
				page.length > 0 && page.length <= limit,
				`every page must hold at least one event and at most the limit ${limit}; got ${page.length}`,
			);
			collected.push(...page);
		}
		return collected;
	};
	const sameEventIds = (
		actual: ReadonlyArray<Evt>,
		expected: ReadonlyArray<Evt>,
	): boolean =>
		actual.length === expected.length &&
		actual.every((event, index) => event.eventId === expected[index]?.eventId);

	return [
		{
			name: "full read: the pages hold every event through the head in append order",
			run: inEnv(async (env) => {
				const { stream, events } = await seed(env, 5);

				const read = await readOrFail(env, stream, {
					fromVersion: 0,
					limit: 2,
				});

				assert(
					read.stream.aggregateType === stream.aggregateType &&
						read.stream.aggregateId === stream.aggregateId,
					"the read must name the stream it reads",
				);
				assert(
					read.fromVersion === 0 && read.targetVersion === events.length,
					`a full read must run from 0 to the head ${events.length}; got (${read.fromVersion}, ${read.targetVersion}]`,
				);
				assert(
					sameEventIds(await collectPages(read, 2), events),
					"the pages must hold every event of the stream in append order",
				);
			}),
		},
		{
			name: "catch-up read: the pages start after fromVersion",
			run: inEnv(async (env) => {
				const { stream, events } = await seed(env, 5);

				const read = await readOrFail(env, stream, {
					fromVersion: 2,
					limit: 2,
				});

				assert(
					read.fromVersion === 2 && read.targetVersion === events.length,
					`a catch-up read must run from 2 to the head ${events.length}; got (${read.fromVersion}, ${read.targetVersion}]`,
				);
				assert(
					sameEventIds(await collectPages(read, 2), events.slice(2)),
					"the pages must hold only the events after fromVersion",
				);
			}),
		},
		{
			name: "point-in-time read: toVersion is the target version and the pages end there",
			run: inEnv(async (env) => {
				const { stream, events } = await seed(env, 5);

				const read = await readOrFail(env, stream, {
					fromVersion: 0,
					toVersion: 3,
					limit: 2,
				});

				assert(
					read.targetVersion === 3,
					`a read to version 3 must pin 3 as the target version; got ${read.targetVersion}`,
				);
				assert(
					sameEventIds(await collectPages(read, 2), events.slice(0, 3)),
					"the pages must end at the target version",
				);
			}),
		},
		{
			name: "empty window: a read at the head yields no page",
			run: inEnv(async (env) => {
				const { stream, events } = await seed(env, 3);

				const read = await readOrFail(env, stream, {
					fromVersion: events.length,
					limit: 2,
				});

				assert(
					read.targetVersion === events.length,
					`a read at the head must pin the head ${events.length}; got ${read.targetVersion}`,
				);
				assert(
					(await collectPages(read, 2)).length === 0,
					"a read at the head must yield no page, not an empty one",
				);
			}),
		},
		{
			name: "re-iteration: every iteration yields the same prefix",
			run: inEnv(async (env) => {
				const { stream, events } = await seed(env, 5);
				const read = await readOrFail(env, stream, {
					fromVersion: 0,
					limit: 2,
				});

				const first = await collectPages(read, 2);
				const second = await collectPages(read, 2);

				assert(
					sameEventIds(first, events) && sameEventIds(second, events),
					"a second iteration must start again from the first page and yield the same events",
				);
			}),
		},
		{
			name: "target as upper bound: an append during the iteration stays out of the pages",
			run: inEnv(async (env) => {
				const { stream, events } = await seed(env, 5);
				const read = await readOrFail(env, stream, {
					fromVersion: 0,
					limit: 2,
				});

				const collected: Evt[] = [];
				for await (const page of read.pages) {
					if (collected.length === 0) {
						await env.append(stream, [harness.createEvent(stream, 6)]);
					}
					collected.push(...page);
				}

				assert(
					read.targetVersion === events.length,
					"an append after the read must not move the target version",
				);
				assert(
					sameEventIds(collected, events),
					"the pages must end at the target version and leave the later append out",
				);
			}),
		},
		{
			name: "no replayable read: an absent stream and a window outside the stream",
			run: inEnv(async (env) => {
				const { stream, events } = await seed(env, 3);
				const absent = harness.createStream();
				const outside: ReadonlyArray<ReplayableStreamPagesContractWindow> = [
					{ fromVersion: 0, toVersion: events.length + 1, limit: 2 },
					{ fromVersion: events.length + 1, limit: 2 },
					{ fromVersion: 3, toVersion: 2, limit: 2 },
				];

				assert(
					(await env.read({ ...absent }, { fromVersion: 0, limit: 2 })) ===
						undefined,
					"an absent stream must give no replayable read",
				);
				for (const window of outside) {
					assert(
						(await env.read({ ...stream }, window)) === undefined,
						`the window (${window.fromVersion}, ${window.toVersion ?? "head"}] lies outside a stream at ${events.length} and must give no replayable read`,
					);
				}
			}),
		},
	];
}
