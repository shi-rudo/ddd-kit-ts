import { describe, expect, it } from "vite-plus/test";
import type { PublishedCommand } from "../application/cqrs/command/command";
import type {
	CommandOutboxCommitCandidate,
	CommandOutboxWriter,
} from "../application/cqrs/command/command-outbox";
import type { AggregateIdentity } from "../domain/aggregate/aggregate-identity";
import {
	type CommandOutboxContractEnvironment,
	type CommandOutboxContractHarness,
	createCommandOutboxContractTests,
} from "./command-outbox-contract";

type TestCommand = PublishedCommand<
	"DoWork",
	{ readonly seed: number; readonly label: string }
>;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function createInMemoryHarness(): CommandOutboxContractHarness<TestCommand> {
	return {
		createCommand: (seed) => ({
			type: "DoWork",
			version: 1,
			payload: { seed, label: `work-${seed}` },
		}),
		createEnvironment: async () => {
			type Store = {
				readonly receipts: Map<
					string,
					CommandOutboxCommitCandidate<TestCommand>
				>;
				readonly endedSources: Set<string>;
			};
			let committed: Store = { receipts: new Map(), endedSources: new Set() };
			let active: Store | undefined;
			const sourceKey = (source: AggregateIdentity): string =>
				JSON.stringify([source.aggregateType, source.aggregateId]);
			const outbox: CommandOutboxWriter<TestCommand> = {
				add: async (commits) => {
					if (!active) throw new Error("write attempted outside transaction");
					for (const commit of commits) {
						const prior = active.receipts.get(commit.origin.eventId);
						if (prior !== undefined && !same(prior, commit)) {
							throw new Error(
								`conflicting origin event id ${commit.origin.eventId}`,
							);
						}
						if (
							prior === undefined &&
							active.endedSources.has(sourceKey(commit.origin.source))
						) {
							throw new Error(`the source of ${commit.origin.eventId} ended`);
						}
					}
					for (const commit of commits) {
						if (!active.receipts.has(commit.origin.eventId)) {
							active.receipts.set(commit.origin.eventId, clone(commit));
						}
					}
				},
				endEventSources: async (sources) => {
					if (!active) throw new Error("write attempted outside transaction");
					for (const source of sources) {
						const key = sourceKey(source);
						const hasCursor = [...active.receipts.values()].some(
							(receipt) => sourceKey(receipt.origin.source) === key,
						);
						if (hasCursor) active.endedSources.add(key);
					}
				},
			};
			const transact = async (
				write: () => Promise<void>,
				commit: boolean,
			): Promise<void> => {
				active = {
					receipts: new Map(
						[...committed.receipts].map(([id, candidate]) => [
							id,
							clone(candidate),
						]),
					),
					endedSources: new Set(committed.endedSources),
				};
				try {
					await write();
					if (commit) committed = active;
				} finally {
					active = undefined;
				}
			};
			const environment: CommandOutboxContractEnvironment<TestCommand> = {
				outbox,
				addCommitted: (commits) => transact(() => outbox.add(commits), true),
				addRolledBack: (commits) => transact(() => outbox.add(commits), false),
				endEventSourcesCommitted: (sources) =>
					transact(() => outbox.endEventSources(sources), true),
				endEventSourcesRolledBack: (sources) =>
					transact(() => outbox.endEventSources(sources), false),
				readAll: async () => [...committed.receipts.values()].map(clone),
			};
			return environment;
		},
		providesRolledBackAdds: true,
		providesRolledBackEnds: true,
	};
}

describe("command outbox contract suite", () => {
	const tests = createCommandOutboxContractTests(createInMemoryHarness());

	for (const test of tests) {
		(test.skipped ? it.skip : it)(test.name, test.run);
	}

	it("runs every guarantee against the transactional in-memory adapter", () => {
		expect(tests.filter((test) => test.skipped)).toEqual([]);
		expect(tests.map((test) => test.name)).toEqual(
			expect.arrayContaining([
				"deduplicates an exact retry by origin event id",
				"rejects conflicting reuse of an origin event id",
				"rejects an origin event id reused with a different source",
				"rejects an origin event id reused with a different position",
				"rejects a conflicting batch atomically",
				"retains command and commit input order",
				"retains every position in a multi-event aggregate commit",
				"retains an empty command receipt and advances the source cursor",
				"rejects a new commit of an ended source",
				"deduplicates an exact retry of a commit of an ended source",
				"ending a source without a cursor leaves it open for its first commit",
				"a rolled-back add leaves no receipt or command behind",
				"a rolled-back end leaves the source open",
			]),
		);
	});

	it("exposes an adapter that ignores endEventSources", async () => {
		const harness = createInMemoryHarness();
		const broken: CommandOutboxContractHarness<TestCommand> = {
			...harness,
			createEnvironment: async () => ({
				...(await harness.createEnvironment()),
				endEventSourcesCommitted: async () => {},
			}),
		};
		const test = createCommandOutboxContractTests(broken).find(
			(candidate) =>
				candidate.name === "rejects a new commit of an ended source",
		);

		expect(test).toBeDefined();
		await expect(test?.run()).rejects.toThrow(
			/a new commit of an ended source must reject/,
		);
	});

	it("exposes an adapter that appends duplicate retries", async () => {
		const broken: CommandOutboxContractHarness<TestCommand> = {
			...createInMemoryHarness(),
			createEnvironment: async () => {
				const rows: Array<CommandOutboxCommitCandidate<TestCommand>> = [];
				const outbox: CommandOutboxWriter<TestCommand> = {
					add: async (commits) => {
						rows.push(...commits.map(clone));
					},
					endEventSources: async () => {},
				};
				return {
					outbox,
					addCommitted: (
						commits: ReadonlyArray<CommandOutboxCommitCandidate<TestCommand>>,
					) => outbox.add(commits),
					endEventSourcesCommitted: (sources) =>
						outbox.endEventSources(sources),
					readAll: async () => rows.map(clone),
				};
			},
			providesRolledBackAdds: false,
			providesRolledBackEnds: false,
		};
		const retryTest = createCommandOutboxContractTests(broken).find(
			(test) => test.name === "deduplicates an exact retry by origin event id",
		);

		expect(retryTest).toBeDefined();
		await expect(retryTest?.run()).rejects.toThrow(/exact retry|one receipt/i);
	});

	it("exposes an adapter that compares only selected origin facts", async () => {
		const broken: CommandOutboxContractHarness<TestCommand> = {
			...createInMemoryHarness(),
			createEnvironment: async () => {
				const rows = new Map<
					string,
					CommandOutboxCommitCandidate<TestCommand>
				>();
				const outbox: CommandOutboxWriter<TestCommand> = {
					add: async (commits) => {
						for (const commit of commits) {
							const prior = rows.get(commit.origin.eventId);
							if (
								prior &&
								(!same(prior.messages, commit.messages) ||
									prior.origin.source.aggregateId !==
										commit.origin.source.aggregateId ||
									prior.origin.position.aggregateVersion !==
										commit.origin.position.aggregateVersion)
							) {
								throw new Error("conflicting messages");
							}
							if (!prior) rows.set(commit.origin.eventId, clone(commit));
						}
					},
					endEventSources: async () => {},
				};
				return {
					outbox,
					addCommitted: (commits) => outbox.add(commits),
					endEventSourcesCommitted: (sources) =>
						outbox.endEventSources(sources),
					readAll: async () => [...rows.values()].map(clone),
				};
			},
			providesRolledBackAdds: false,
			providesRolledBackEnds: false,
		};
		const contract = createCommandOutboxContractTests(broken);

		for (const [name, missingFact] of [
			[
				"rejects an origin event id reused with a different source",
				"aggregateType",
			],
			[
				"rejects an origin event id reused with a different position",
				"commitSequence",
			],
		] as const) {
			const test = contract.find((candidate) => candidate.name === name);
			expect(test).toBeDefined();
			await expect(test?.run()).rejects.toThrow(missingFact);
		}
	});

	it("exposes an adapter that flattens multi-event commit positions", async () => {
		const broken: CommandOutboxContractHarness<TestCommand> = {
			...createInMemoryHarness(),
			createEnvironment: async () => {
				const rows: Array<CommandOutboxCommitCandidate<TestCommand>> = [];
				const outbox: CommandOutboxWriter<TestCommand> = {
					add: async (commits) => {
						rows.push(
							...commits.map((commit) =>
								clone({
									...commit,
									origin: {
										...commit.origin,
										position: {
											...commit.origin.position,
											commitSequence: 0,
											commitSize: 1,
										},
									},
								}),
							),
						);
					},
					endEventSources: async () => {},
				};
				return {
					outbox,
					addCommitted: (commits) => outbox.add(commits),
					endEventSourcesCommitted: (sources) =>
						outbox.endEventSources(sources),
					readAll: async () => rows.map(clone),
				};
			},
			providesRolledBackAdds: false,
			providesRolledBackEnds: false,
		};
		const test = createCommandOutboxContractTests(broken).find(
			(candidate) =>
				candidate.name ===
				"retains every position in a multi-event aggregate commit",
		);

		expect(test).toBeDefined();
		await expect(test?.run()).rejects.toThrow(/position|multi-event/i);
	});
});
