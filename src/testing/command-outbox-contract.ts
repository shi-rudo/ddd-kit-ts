import type { PublishedCommand } from "../app/command";
import type {
	CommandOutboxCommitCandidate,
	CommandOutboxWriter,
	DurableCommandMessage,
} from "../app/command-outbox";
import { deepEqual } from "../utils/array/deep-equal";
import {
	assert,
	assertEqual,
	bindContractEnvironment,
	type ContractTest,
	captureRejection,
	gatedContractTest,
} from "./contract-assertions";

export interface CommandOutboxContractEnvironment<C extends PublishedCommand> {
	readonly outbox: CommandOutboxWriter<C>;
	readonly addCommitted: (
		commits: ReadonlyArray<CommandOutboxCommitCandidate<C>>,
	) => Promise<void>;
	readonly addRolledBack?: (
		commits: ReadonlyArray<CommandOutboxCommitCandidate<C>>,
	) => Promise<void>;
	readonly readAll: () => Promise<
		ReadonlyArray<CommandOutboxCommitCandidate<C>>
	>;
	readonly teardown?: () => Promise<void>;
}

export interface CommandOutboxContractHarness<C extends PublishedCommand> {
	readonly createEnvironment: () => Promise<
		CommandOutboxContractEnvironment<C>
	>;
	readonly createCommand: (seed: number) => C;
	readonly providesRolledBackAdds?: boolean;
}

export type CommandOutboxContractTest = ContractTest;

export function createCommandOutboxContractTests<C extends PublishedCommand>(
	harness: CommandOutboxContractHarness<C>,
): ReadonlyArray<CommandOutboxContractTest> {
	const inEnv = bindContractEnvironment(harness.createEnvironment);
	const commit = (
		seed: number,
		commandSeeds: ReadonlyArray<number> = [seed],
	): CommandOutboxCommitCandidate<C> => ({
		origin: {
			eventId: `process-event-${seed}`,
			source: {
				aggregateType: "CheckoutProcess",
				aggregateId: "order-1",
			},
			position: {
				aggregateVersion: seed,
				commitSequence: 0,
				commitSize: 1,
			},
		},
		messages: commandSeeds.map((commandSeed, index) =>
			message(seed, index, harness.createCommand(commandSeed)),
		),
	});
	const tests: CommandOutboxContractTest[] = [
		{
			name: "deduplicates an exact retry by origin event id",
			run: inEnv(async (env) => {
				const original = commit(1);
				await env.addCommitted([original]);
				await env.addCommitted([original]);
				const stored = await env.readAll();
				assertEqual(
					stored.length,
					1,
					"an exact retry must retain one receipt, not append a duplicate",
				);
				assert(
					deepEqual(stored[0], original),
					"an exact retry must preserve the original receipt and commands",
				);
			}),
		},
		{
			name: "rejects conflicting reuse of an origin event id",
			run: inEnv(async (env) => {
				const original = commit(1);
				await env.addCommitted([original]);
				const conflict = {
					...commit(1, [99]),
					origin: {
						...commit(1, [99]).origin,
						eventId: original.origin.eventId,
					},
				};
				const rejection = await captureRejection(env.addCommitted([conflict]));
				assert(
					rejection !== undefined,
					"a reused origin event id with different messages must reject",
				);
				const stored = await env.readAll();
				assertEqual(
					stored.length,
					1,
					"a conflicting retry must not append another receipt",
				);
				assert(
					deepEqual(stored[0], original),
					"a conflicting retry must not replace the original receipt",
				);
			}),
		},
		{
			name: "rejects a conflicting batch atomically",
			run: inEnv(async (env) => {
				const original = commit(1);
				await env.addCommitted([original]);
				const newCommit = commit(2);
				const conflictingOriginal = {
					...commit(1, [77]),
					origin: {
						...commit(1, [77]).origin,
						eventId: original.origin.eventId,
					},
				};
				const rejection = await captureRejection(
					env.addCommitted([newCommit, conflictingOriginal]),
				);
				assert(
					rejection !== undefined,
					"a batch containing a conflicting origin must reject",
				);
				const stored = await env.readAll();
				assertEqual(
					stored.length,
					1,
					"a rejected batch must not leave its earlier new receipt behind",
				);
				assert(
					deepEqual(stored[0], original),
					"a rejected batch must preserve the pre-existing receipt",
				);
			}),
		},
		{
			name: "retains command and commit input order",
			run: inEnv(async (env) => {
				const first = commit(1, [10, 11]);
				const second = commit(2, [20, 21]);
				await env.addCommitted([first, second]);
				const stored = await env.readAll();
				assert(
					deepEqual(
						stored.map(({ origin }) => origin.eventId),
						[first.origin.eventId, second.origin.eventId],
					),
					"commit receipts must retain input order",
				);
				assert(
					deepEqual(
						stored.map(({ messages }) =>
							messages.map(({ command }) => command),
						),
						[
							first.messages.map(({ command }) => command),
							second.messages.map(({ command }) => command),
						],
					),
					"commands inside each receipt must retain mapper order",
				);
			}),
		},
		{
			name: "retains an empty command receipt and advances the source cursor",
			run: inEnv(async (env) => {
				const empty = commit(1, []);
				const next = commit(2);
				await env.addCommitted([empty]);
				await env.addCommitted([next]);
				const stored = await env.readAll();
				assertEqual(
					stored.length,
					2,
					"an empty command batch must retain its source receipt",
				);
				assertEqual(
					stored[0]?.messages.length,
					0,
					"the retained empty receipt must contain no invented command",
				);
				assert(
					deepEqual(
						stored.map(({ origin }) => origin.position.aggregateVersion),
						[1, 2],
					),
					"the source cursor must advance through the empty receipt",
				);
			}),
		},
	];
	tests.push(
		gatedContractTest(
			{
				capability: "providesRolledBackAdds",
				satisfiedBy: harness.providesRolledBackAdds === true,
			},
			{
				name: "a rolled-back add leaves no receipt or command behind",
				run: inEnv(async (env) => {
					if (!env.addRolledBack) {
						throw new Error(
							"Contract violated: harness declared providesRolledBackAdds but the environment lacks addRolledBack",
						);
					}
					await env.addRolledBack([commit(1)]);
					assertEqual(
						(await env.readAll()).length,
						0,
						"a rolled-back transaction must persist no command receipt",
					);
				}),
			},
		),
	);
	return tests;
}

function message<C extends PublishedCommand>(
	commitSeed: number,
	index: number,
	command: C,
): DurableCommandMessage<C> {
	return {
		messageId: `process-event-${commitSeed}:command:${index}`,
		recordedAt: "2027-04-05T06:07:08.000Z",
		destination: "participant.commands",
		command,
		conversationId: "checkout-order-1",
		causationId: `process-event-${commitSeed}`,
	};
}
