import {
	DEFAULT_EFFECT_TIMEOUT_MS,
	type EffectContext,
	runBoundedEffect,
} from "../utils/effect";
import { captureObserverFunctions, reportToObserver } from "../utils/observer";
import { PollLoop } from "../utils/poll-loop";
import { assertNonNegativeFinite } from "../utils/validate";
import type {
	DeadlineStore,
	DeadLetterDeadline,
	DueDeadline,
} from "./deadline-store";

/**
 * Required operational observers for {@link DeadlineProcessor}. All hooks are
 * best-effort notifications: synchronous throws and rejected promises are
 * neutralized so observability cannot change delivery state. The processor
 * captures and freezes these function references at construction, so later
 * mutation of the supplied object cannot disable an operational channel.
 *
 * `onDeadLetter` fires immediately after `markFailed` reports the exact
 * transition. It is not a durable notification boundary: a process can stop
 * after the store commits the transition and before the callback runs. Keep
 * polling {@link DeadlineStore.deadLetters} for durable alerting and
 * reconciliation; the hook provides low-latency diagnostics.
 */
export interface DeadlineProcessorObservers<TPayload> {
	/** A handler, acknowledgement, or failure-tracking operation failed. */
	readonly onDeliveryError: (
		error: unknown,
		deadline: DueDeadline<TPayload>,
	) => void;
	/** Reading the due page failed. */
	readonly onPollError: (error: unknown) => void;
	/** A deadline crossed the store's dead-letter threshold. */
	readonly onDeadLetter: (deadline: DeadLetterDeadline<TPayload>) => void;
}

/** Construction options for {@link DeadlineProcessor}. */
export interface DeadlineProcessorOptions<TPayload> {
	/** The poll surface; see {@link DeadlineStore}. */
	store: DeadlineStore<TPayload>;

	/** Complete, required operational observer bundle. */
	observers: DeadlineProcessorObservers<TPayload>;

	/**
	 * Receives each due deadline as an input. A throw signals delivery
	 * failure: the processor reports it via `markFailed` (the store
	 * dead-letters past its ceiling) and moves on to the next deadline;
	 * neighbors are independent. Remember the guide's discipline: a
	 * delivered deadline is a proposal, so check it against current
	 * state before acting. Pass `context.signal` to I/O adapters; its
	 * `deadlineAt` matches the processor's per-delivery bound.
	 */
	handler: (
		deadline: DueDeadline<TPayload>,
		context: EffectContext,
	) => Promise<void> | void;

	/** Deadlines fetched per poll. Default `32`. */
	batchSize?: number;

	/** Idle sleep between polls when nothing is due. Default `250`ms. */
	pollIntervalMs?: number;

	/**
	 * First backoff delay after a failed cycle; grows exponentially with
	 * the processor's consecutive-failure streak and is jittered.
	 * Default `50`ms.
	 */
	baseDelayMs?: number;

	/** Ceiling for the failure backoff. Default `5000`ms. */
	maxDelayMs?: number;

	/**
	 * Maximum time to await one deadline handler. The handler receives the same
	 * deadline as an AbortSignal and an absolute `deadlineAt`. Default `30000`ms.
	 */
	deliveryTimeoutMs?: number;

	/**
	 * Jitter source for the failure backoff, injectable for
	 * deterministic tests. Default `Math.random`. Neutralized like every
	 * user callback: a throwing or non-finite source degrades to the
	 * midpoint multiplier.
	 */
	random?: () => number;

	/**
	 * The clock the poll passes to {@link DeadlineStore.due}. Default
	 * `() => new Date()`. Injectable so tests fire deadlines without
	 * waiting; a throwing clock degrades to the system time.
	 */
	clock?: () => Date;
}

/**
 * The hardened delivery loop for {@link DeadlineStore}: poll due
 * deadlines, hand each one to the handler, acknowledge or report the
 * failure. The delivery semantics are deliberately simpler than the
 * outbox dispatcher's, because deadlines carry no ordering: a HANDLER
 * failure never stops the batch; the failing deadline is reported via
 * `markFailed` and its neighbors keep flowing in the same cycle.
 *
 * What it shares with the dispatcher is the loop hardening, which is
 * exactly the part hand-rolled loops get wrong:
 *
 * - **Never rejects.** Poll errors, handler throws, ack failures, and
 *   observer bugs are absorbed and reported; `run(signal)` resolves on
 *   abort and never becomes an unhandled rejection.
 * - **Backs off under failure.** A cycle containing any failure grows
 *   the jittered exponential backoff toward `maxDelayMs` (one step per
 *   cycle); an empty backlog or a clean cycle resets the streak.
 * - **Reentrancy-safe.** A `drainOnce` call while a pass is in flight
 *   joins that pass instead of starting a competing poll (overlapping
 *   cron ticks would double-deliver); a joining call still honors its
 *   own signal.
 * - **At-least-once.** A crash or ack failure after handling
 *   redelivers; handlers stay idempotent (the guide shows the
 *   idempotency-store wiring). Delivered deadlines are acknowledged in
 *   ONE `markDelivered` call per cycle, and an ack failure ends the
 *   cycle: it signals the store's write path, not a poison record, so
 *   it is reported per affected deadline, never to `markFailed`
 *   (counting it toward the poison ceiling would dead-letter healthy
 *   work), and the backoff paces the redelivery instead of the pass
 *   re-running every handler against a dead write path.
 *
 * Run one logical processor per store unless the adapter's `due`
 * claims records; the same rule as the dispatcher.
 */
export class DeadlineProcessor<TPayload = unknown> extends PollLoop {
	private readonly store: DeadlineStore<TPayload>;
	private readonly handler: (
		deadline: DueDeadline<TPayload>,
		context: EffectContext,
	) => Promise<void> | void;
	private readonly clock: () => Date;
	private readonly observers: DeadlineProcessorObservers<TPayload>;
	private readonly deliveryTimeoutMs: number;

	constructor(options: DeadlineProcessorOptions<TPayload>) {
		super("DeadlineProcessor", options);
		this.observers = captureObserverFunctions(
			"DeadlineProcessor",
			options.observers,
			["onDeliveryError", "onPollError", "onDeadLetter"],
		);
		this.store = options.store;
		this.handler = options.handler;
		this.clock = options.clock ?? (() => new Date());
		this.deliveryTimeoutMs =
			options.deliveryTimeoutMs ?? DEFAULT_EFFECT_TIMEOUT_MS;
		assertNonNegativeFinite(
			"DeadlineProcessor",
			"deliveryTimeoutMs",
			this.deliveryTimeoutMs,
		);
	}

	/**
	 * One full delivery pass (the `run`/`drainOnce` shell lives on
	 * {@link PollLoop}): delivers due deadlines batch by batch until
	 * nothing is due or a cycle contained a failure.
	 */
	protected async pass(signal?: AbortSignal): Promise<"drained" | "stopped"> {
		while (!signal?.aborted) {
			let batch: ReadonlyArray<DueDeadline<TPayload>>;
			try {
				batch = await this.store.due(this.now(), this.batchSize);
			} catch (error) {
				this.consecutiveFailures += 1;
				reportToObserver(() => this.observers.onPollError(error));
				return "stopped";
			}
			if (batch.length === 0) {
				this.consecutiveFailures = 0;
				return "drained";
			}

			// Handler failures do NOT stop the batch: deadlines carry no
			// cross-address ordering, so a poison deadline blocks only
			// itself and is reported to the store's bounded retries.
			let handlerFailed = false;
			const delivered: DueDeadline<TPayload>[] = [];
			for (const deadline of batch) {
				if (signal?.aborted) break;
				try {
					await runBoundedEffect(
						"DeadlineProcessor.handler",
						{ signal, timeoutMs: this.deliveryTimeoutMs },
						(context) => this.handler(deadline, context),
					);
					delivered.push(deadline);
				} catch (error) {
					if (signal?.aborted) break;
					handlerFailed = true;
					reportToObserver(() =>
						this.observers.onDeliveryError(error, deadline),
					);
					try {
						const deadLetter = await this.store.markFailed(
							deadline.deliveryId,
							error,
						);
						if (deadLetter !== undefined) {
							reportToObserver(() => this.observers.onDeadLetter(deadLetter));
						}
					} catch (markError) {
						reportToObserver(() =>
							this.observers.onDeliveryError(markError, deadline),
						);
					}
				}
			}

			// One ack round-trip per cycle. An ack failure DOES stop the
			// cycle: it signals the store's write path, not a poison
			// record; continuing would re-run every handler against a dead
			// write path on each backoff step. Every handled deadline will
			// redeliver (the documented duplicates), so each is reported.
			let acked = true;
			if (delivered.length > 0) {
				try {
					await this.store.markDelivered(
						delivered.map((deadline) => deadline.deliveryId),
					);
				} catch (error) {
					acked = false;
					for (const deadline of delivered) {
						reportToObserver(() =>
							this.observers.onDeliveryError(error, deadline),
						);
					}
				}
			}

			if (handlerFailed || !acked) {
				// One streak bump per failed cycle; run()'s backoff sleep
				// paces the retry (a bare drainOnce loop gets its pacing
				// from the tick cadence instead).
				this.consecutiveFailures += 1;
				return "stopped";
			}
			this.consecutiveFailures = 0;
			// An abort mid-batch left deadlines unhandled; not a failure,
			// but not a drained backlog either.
			if (signal?.aborted) return "stopped";
		}
		return "stopped";
	}

	/**
	 * The injected clock, neutralized like every user callback: a
	 * throwing clock, and equally an Invalid Date, degrades to system
	 * time. An Invalid Date would otherwise compare false against every
	 * dueAt and silently halt all delivery with no observer signal.
	 */
	private now(): Date {
		try {
			const value = this.clock();
			return Number.isNaN(value.getTime()) ? new Date() : value;
		} catch {
			return new Date();
		}
	}
}
