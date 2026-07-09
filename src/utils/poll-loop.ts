import { computeBackoffDelay, neutralJitterSource } from "./backoff";
import { joinWithoutBlockingOnAbort } from "./in-flight";
import { sleepResolvingOnAbort } from "./sleep";
import { assertNonNegativeFinite, assertPositiveInteger } from "./validate";

/** Numeric options every kit poll loop shares; see the concrete classes. */
export interface PollLoopOptions {
	batchSize?: number;
	pollIntervalMs?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	random?: () => number;
}

/**
 * The hardened poll-loop shell shared by `OutboxDispatcher` and
 * `DeadlineProcessor`, so the operationally tricky parts exist exactly
 * once: the never-rejecting `run(signal)` cadence (idle sleep when
 * drained, jittered streak backoff when stopped), the reentrancy-safe
 * `drainOnce` that joins an in-flight pass instead of starting a
 * competing one, option validation, and the per-instance neutralized
 * jitter source. Subclasses implement one thing: {@link pass}, the
 * delivery semantics of their port. Internal plumbing, not exported
 * from the package entries.
 */
export abstract class PollLoop {
	protected readonly batchSize: number;
	private readonly pollIntervalMs: number;
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly jitter: () => number;

	/**
	 * Failed cycles since the last clean one; drives the backoff.
	 * Subclasses bump it once per failed cycle and reset it on clean or
	 * empty cycles (a subclass may bump by more, e.g. to a record's
	 * attempt count, via direct assignment).
	 */
	protected consecutiveFailures = 0;

	/** In-flight pass; overlapping drainOnce calls join it. */
	private inFlightPass?: Promise<"drained" | "stopped">;

	protected constructor(context: string, options: PollLoopOptions) {
		const batchSize = options.batchSize ?? 32;
		assertPositiveInteger(context, "batchSize", batchSize);
		this.batchSize = batchSize;
		this.pollIntervalMs = options.pollIntervalMs ?? 250;
		this.baseDelayMs = options.baseDelayMs ?? 50;
		this.maxDelayMs = options.maxDelayMs ?? 5000;
		assertNonNegativeFinite(context, "pollIntervalMs", this.pollIntervalMs);
		assertNonNegativeFinite(context, "baseDelayMs", this.baseDelayMs);
		assertNonNegativeFinite(context, "maxDelayMs", this.maxDelayMs);
		this.jitter = neutralJitterSource(options.random ?? Math.random);
	}

	/**
	 * One full pass over the backlog: loop batches until nothing is
	 * pending (`"drained"`) or a failure ends the cycle (`"stopped"`).
	 * Must never reject; only ever one pass is in flight.
	 */
	protected abstract pass(signal?: AbortSignal): Promise<"drained" | "stopped">;

	/**
	 * Runs the poll loop until `signal` aborts, then resolves. Never
	 * rejects: a `"drained"` pass sleeps `pollIntervalMs`, a `"stopped"`
	 * one sleeps the current streak backoff.
	 */
	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			const outcome = await this.drainOnce(signal);
			if (signal.aborted) return;
			if (outcome === "drained") {
				await sleepResolvingOnAbort(this.pollIntervalMs, signal);
			} else {
				await sleepResolvingOnAbort(this.currentBackoff(), signal);
			}
		}
	}

	/**
	 * Single pass for cron triggers and serverless runtimes; returns
	 * without sleeping (the tick cadence is the retry pacing; only
	 * `run` sleeps the backoff). Reentrancy-safe: a call during an
	 * in-flight pass joins it, and the joining call's own `signal`
	 * still ends its wait while the pass runs on for its owner.
	 *
	 * With producers that keep the backlog non-empty, "until drained"
	 * can outlast a bounded invocation: pass a `signal` wired to your
	 * runtime's deadline (`AbortSignal.timeout(...)`) so the pass ends
	 * cleanly; completed work stays acknowledged, the rest waits for
	 * the next tick.
	 */
	async drainOnce(signal?: AbortSignal): Promise<"drained" | "stopped"> {
		if (this.inFlightPass !== undefined) {
			return joinWithoutBlockingOnAbort(this.inFlightPass, signal);
		}
		const pass = this.pass(signal);
		this.inFlightPass = pass;
		try {
			return await pass;
		} finally {
			this.inFlightPass = undefined;
		}
	}

	/** Backoff for the current consecutive-failure streak. */
	private currentBackoff(): number {
		return computeBackoffDelay(Math.max(1, this.consecutiveFailures), {
			baseDelayMs: this.baseDelayMs,
			maxDelayMs: this.maxDelayMs,
			random: this.jitter,
		});
	}
}
