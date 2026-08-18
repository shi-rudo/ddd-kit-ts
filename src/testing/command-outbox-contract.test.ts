import { describe, expect, it } from "vite-plus/test";
import type { PublishedCommand } from "../app/command";
import type {
	CommandOutboxCommitCandidate,
	CommandOutboxWriter,
} from "../app/command-outbox";
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
			let committed = new Map<
				string,
				CommandOutboxCommitCandidate<TestCommand>
			>();
			let active:
				| Map<string, CommandOutboxCommitCandidate<TestCommand>>
				| undefined;
			const outbox: CommandOutboxWriter<TestCommand> = {
				add: async (commits) => {
					if (!active) throw new Error("write attempted outside transaction");
					for (const commit of commits) {
						const prior = active.get(commit.origin.eventId);
						if (prior !== undefined && !same(prior, commit)) {
							throw new Error(
								`conflicting origin event id ${commit.origin.eventId}`,
							);
						}
					}
					for (const commit of commits) {
						if (!active.has(commit.origin.eventId)) {
							active.set(commit.origin.eventId, clone(commit));
						}
					}
				},
			};
			const transact = async (
				commits: ReadonlyArray<CommandOutboxCommitCandidate<TestCommand>>,
				commit: boolean,
			): Promise<void> => {
				active = new Map(
					[...committed].map(([id, candidate]) => [id, clone(candidate)]),
				);
				try {
					await outbox.add(commits);
					if (commit) committed = active;
				} finally {
					active = undefined;
				}
			};
			const environment: CommandOutboxContractEnvironment<TestCommand> = {
				outbox,
				addCommitted: (commits) => transact(commits, true),
				addRolledBack: (commits) => transact(commits, false),
				readAll: async () => [...committed.values()].map(clone),
			};
			return environment;
		},
		providesRolledBackAdds: true,
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
				"a rolled-back add leaves no receipt or command behind",
			]),
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
				};
				return {
					outbox,
					addCommitted: (
						commits: ReadonlyArray<CommandOutboxCommitCandidate<TestCommand>>,
					) => outbox.add(commits),
					readAll: async () => rows.map(clone),
				};
			},
			providesRolledBackAdds: false,
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
				};
				return {
					outbox,
					addCommitted: (commits) => outbox.add(commits),
					readAll: async () => [...rows.values()].map(clone),
				};
			},
			providesRolledBackAdds: false,
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
				};
				return {
					outbox,
					addCommitted: (commits) => outbox.add(commits),
					readAll: async () => rows.map(clone),
				};
			},
			providesRolledBackAdds: false,
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
