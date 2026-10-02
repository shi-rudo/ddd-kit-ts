import { describe, expect, it } from "vite-plus/test";
import type { InMemoryTransactionParticipant } from "../in-memory-transaction";
import { InMemoryTransactionScope } from "./in-memory-transaction-scope";

function recordingParticipant(
	name: string,
	steps: string[],
	options: {
		readonly commitFails?: boolean;
		readonly rollbackFails?: boolean;
	} = {},
): InMemoryTransactionParticipant {
	return {
		beginTransaction: () => {
			steps.push(`begin ${name}`);
			return {
				commit: () => {
					steps.push(`commit ${name}`);
					if (options.commitFails) {
						throw new Error(`commit of ${name} failed`);
					}
				},
				rollback: () => {
					steps.push(`rollback ${name}`);
					if (options.rollbackFails) {
						throw new Error(`rollback of ${name} failed`);
					}
				},
			};
		},
	};
}

describe("InMemoryTransactionScope", () => {
	it("rolls every participant back in reverse order when the work fails", async () => {
		const steps: string[] = [];
		const failure = new Error("work failed");
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
			recordingParticipant("events", steps),
		]);

		const rejection = await scope
			.transactional(async () => {
				steps.push("work");
				throw failure;
			})
			.then(
				() => "committed",
				(error: unknown) => error,
			);

		expect(rejection).toBe(failure);
		expect(steps).toEqual([
			"begin outbox",
			"begin events",
			"work",
			"rollback events",
			"rollback outbox",
		]);
	});

	it("commits every participant in order when the work succeeds", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
			recordingParticipant("events", steps),
		]);

		const result = await scope.transactional(async () => {
			steps.push("work");
			return "done";
		});

		expect(result).toBe("done");
		expect(steps).toEqual([
			"begin outbox",
			"begin events",
			"work",
			"commit outbox",
			"commit events",
		]);
	});

	it("commits every participant and reports the first commit failure", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps, { commitFails: true }),
			recordingParticipant("events", steps),
		]);

		await expect(scope.transactional(async () => "done")).rejects.toThrow(
			"commit of outbox failed",
		);
		expect(steps).toEqual([
			"begin outbox",
			"begin events",
			"commit outbox",
			"commit events",
		]);
	});

	it("runs one transaction at a time", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
		]);
		let releaseFirst!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		const first = scope.transactional(async () => {
			steps.push("first work");
			await firstReleased;
			steps.push("first done");
		});
		const second = scope.transactional(async () => {
			steps.push("second work");
		});
		await Promise.resolve();
		releaseFirst();
		await Promise.all([first, second]);

		expect(steps).toEqual([
			"begin outbox",
			"first work",
			"first done",
			"commit outbox",
			"begin outbox",
			"second work",
			"commit outbox",
		]);
	});

	it("runs the next transaction after a failed one", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
		]);

		const failed = scope.transactional(async () => {
			throw new Error("work failed");
		});
		const next = scope.transactional(async () => "next");

		await expect(failed).rejects.toThrow("work failed");
		await expect(next).resolves.toBe("next");
		expect(steps).toEqual([
			"begin outbox",
			"rollback outbox",
			"begin outbox",
			"commit outbox",
		]);
	});

	it("rolls back every participant and reports the first rollback failure", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
			recordingParticipant("events", steps, { rollbackFails: true }),
		]);

		const rejection = await scope
			.transactional(async () => {
				throw new Error("work failed");
			})
			.then(
				() => "committed",
				(error: unknown) => error,
			);

		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe("rollback of events failed");
		expect(steps).toEqual([
			"begin outbox",
			"begin events",
			"rollback events",
			"rollback outbox",
		]);
	});

	it("rolls back the participants that began when a later one fails to begin", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
			recordingParticipant("events", steps),
			{
				beginTransaction: () => {
					throw new Error("begin of checkpoints failed");
				},
			},
		]);

		await expect(scope.transactional(async () => "done")).rejects.toThrow(
			"begin of checkpoints failed",
		);
		expect(steps).toEqual([
			"begin outbox",
			"begin events",
			"rollback events",
			"rollback outbox",
		]);
	});

	it("rejects a queued transaction when its signal aborts", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
		]);
		let releaseFirst!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = scope.transactional(() => firstReleased);
		const controller = new AbortController();
		const queued = scope.transactional(async () => "ran", {
			signal: controller.signal,
		});

		controller.abort(new Error("caller gave up"));

		await expect(queued).rejects.toThrow("caller gave up");
		releaseFirst();
		await first;
		expect(steps).toEqual(["begin outbox", "commit outbox"]);
	});

	it("keeps the order of the queue when a queued transaction aborts", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
		]);
		let releaseFirst!: () => void;
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = scope.transactional(async () => {
			await firstReleased;
			steps.push("first done");
		});
		const controller = new AbortController();
		const aborted = scope.transactional(async () => "ran", {
			signal: controller.signal,
		});
		const third = scope.transactional(async () => {
			steps.push("third work");
		});

		controller.abort(new Error("caller gave up"));
		await expect(aborted).rejects.toThrow("caller gave up");
		await Promise.resolve();
		releaseFirst();
		await Promise.all([first, third]);

		expect(steps).toEqual([
			"begin outbox",
			"first done",
			"commit outbox",
			"begin outbox",
			"third work",
			"commit outbox",
		]);
	});

	it("rejects with the abort reason before the transaction begins", async () => {
		const steps: string[] = [];
		const scope = new InMemoryTransactionScope([
			recordingParticipant("outbox", steps),
		]);
		const controller = new AbortController();
		controller.abort(new Error("caller gave up"));

		await expect(
			scope.transactional(async () => "done", { signal: controller.signal }),
		).rejects.toThrow("caller gave up");
		expect(steps).toEqual([]);
	});

	it("rejects a store that another scope registered", () => {
		const store = recordingParticipant("outbox", []);
		new InMemoryTransactionScope([store]);

		expect(() => new InMemoryTransactionScope([store])).toThrow(
			/participant 0 already belongs to an InMemoryTransactionScope/,
		);
	});

	it("rejects a store that the participant list names twice", () => {
		const store = recordingParticipant("outbox", []);

		expect(() => new InMemoryTransactionScope([store, store])).toThrow(
			/participant 1 repeats participant 0/,
		);
	});

	it("rejects a store that a scope of another kit copy registered", async () => {
		const otherCopyPath = "./in-memory-transaction-scope.ts?copy=2";
		const otherCopy = (await import(
			/* @vite-ignore */ otherCopyPath
		)) as typeof import("./in-memory-transaction-scope");
		const store = recordingParticipant("outbox", []);
		new InMemoryTransactionScope([store]);

		expect(otherCopy.InMemoryTransactionScope).not.toBe(
			InMemoryTransactionScope,
		);
		expect(() => new otherCopy.InMemoryTransactionScope([store])).toThrow(
			/participant 0 already belongs to an InMemoryTransactionScope/,
		);
	});

	it("registers no store when the construction fails", () => {
		const store = recordingParticipant("outbox", []);
		expect(
			() =>
				new InMemoryTransactionScope([
					store,
					{} as unknown as InMemoryTransactionParticipant,
				]),
		).toThrow(TypeError);

		expect(() => new InMemoryTransactionScope([store])).not.toThrow();
	});

	it("rejects a participant without beginTransaction", () => {
		expect(
			() =>
				new InMemoryTransactionScope([
					{} as unknown as InMemoryTransactionParticipant,
				]),
		).toThrow(TypeError);
	});
});
