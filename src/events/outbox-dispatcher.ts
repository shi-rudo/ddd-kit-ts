import type { AnyDomainEvent } from "../aggregate/domain-event";

import {
	DEFAULT_EFFECT_TIMEOUT_MS,
	type EffectContext,
	runBoundedEffect,
} from "../utils/effect";
import { captureObserverFunctions, reportToObserver } from "../utils/observer";
import { PollLoop } from "../utils/poll-loop";
import { assertNonNegativeFinite } from "../utils/validate";
import {
	type DispatchTrackingOutbox,
	type DeadLetterRecord,
	type EventBus,
	isDispatchTrackingOutbox,
	type Outbox,
	type OutboxRecord,
} from "./ports";

/**
 * Required operational observers for {@link OutboxDispatcher}. All hooks are
 * best-effort notifications: synchronous throws and rejected promises are
 * neutralized so observability cannot change delivery state. The dispatcher
 * captures and freezes these function references at construction, so later
 * mutation of the supplied object cannot disable an operational channel.
 *
 * `onDeadLetter` fires immediately after `markFailed` reports the exact
 * transition. It is not a durable notification boundary: a process can stop
 * after the store commits the transition and before the callback runs. Keep
 * polling {@link DispatchTrackingOutbox.deadLetters} for durable alerting and
 * reconciliation; the hook provides low-latency diagnostics.
 */
export interface OutboxDispatcherObservers<Evt extends AnyDomainEvent> {
	/** A publish, acknowledgement, or failure-tracking operation failed. */
	readonly onDispatchError: (error: unknown, record: OutboxRecord<Evt>) => void;
	/** Reading the pending page failed. */
	readonly onPollError: (error: unknown) => void;
	/** A tracked record crossed the store's dead-letter threshold. */
	readonly onDeadLetter: (record: DeadLetterRecord<Evt>) => void;
}

/**
 * Delivery target of the {@link OutboxDispatcher}: one driven port with a
 * single question, "deliver this record's event". The consumer implements
 * it against the real transport (message broker, webhook, queue
 * producer); {@link eventBusSink} adapts the in-process `EventBus` for
 * setups without a broker.
 *
 * The sink is called once per record, sequentially, in commit order. A
 * throw signals delivery failure; the dispatcher stops the batch,
 * reports the failure, and retries later (see the dispatcher contract).
 * Sinks must tolerate duplicate delivery: the dispatcher is
 * at-least-once by construction (a crash or ack failure between
 * `publish` and `markDispatched` redelivers). Dedupe on
 * `record.event.eventId`; projection sinks use the event's full gap-proof
 * commit cursor.
 *
 * **Resolve only after the transport acknowledged.** The dispatcher
 * calls `markDispatched` as soon as `publish` resolves, so the
 * resolution IS the delivery confirmation: await the broker's ack
 * (Kafka producer confirm, SQS SendMessage response, JetStream publish
 * ack, HTTP 2xx) before returning. A fire-and-forget publish that
 * resolves early marks records dispatched that the broker may never
 * have stored, which silently voids the at-least-once guarantee the
 * outbox exists to provide.
 *
 * Pass `context.signal` into the transport. `context.deadlineAt` is the
 * absolute form of the dispatcher's per-delivery timeout. The dispatcher
 * settles on timeout or worker abort even if an adapter ignores the signal;
 * the record remains pending unless `publish` had already resolved and its
 * dispatch acknowledgement was persisted.
 */
export interface OutboxSink<Evt extends AnyDomainEvent> {
	publish: (record: OutboxRecord<Evt>, context: EffectContext) => Promise<void>;
}

/**
 * Adapts the in-process {@link EventBus} as an {@link OutboxSink}: the
 * zero-broker setup where the outbox still provides durability and
 * replay, and subscribers run in-process. Handler errors propagate as
 * delivery failures, so failed events retry through the normal
 * dispatcher loop instead of being lost.
 *
 * **Do not combine with `withCommit`'s `bus` fast path on the same
 * bus.** `withCommit({ scope, outbox, bus })` already publishes every
 * committed event to that bus post-commit, and the outbox record stays
 * pending regardless; a dispatcher with `eventBusSink(bus)` then
 * publishes the same event to the same subscribers a second time, on
 * EVERY commit, by construction. Pick one: omit `bus` from `withCommit`
 * and let the dispatcher deliver (durable, replayable), or keep the
 * fast path and point the dispatcher's sink at a different transport.
 *
 * **Retries are per event, not per handler.** One `publish` fans out to
 * ALL subscribers of the event's type, and the bus reports errors only
 * after every handler ran; the outbox tracks the EVENT, not individual
 * handlers. When one subscriber keeps failing, each retry re-executes
 * its co-subscribers too, up to the attempt ceiling. In-process
 * handlers are therefore consumers in the checklist sense: they must
 * be idempotent (dedupe on `eventId`), or non-idempotent reactions
 * (send mail, charge a card) must not share an event subscription with
 * failure-prone handlers. Per-handler delivery tracking is what broker
 * consumer groups (or per-subscriber checkpoints, see the read-model
 * guide) provide; this sink deliberately does not reimplement it.
 *
 * **Subscribe first, then start the dispatcher.** Publishing to a bus
 * with ZERO subscribers for the event's type resolves as delivered
 * (pub/sub semantics: delivery to all current subscribers, even none),
 * so the dispatcher acks the record and it never comes back. Records
 * polled in a startup window before module wiring registered its
 * subscriptions are therefore consumed without any handler seeing
 * them; register every subscription before `run()`/`drainOnce()`. A
 * `subscribeAll` consumer counts as a subscriber for every type. The
 * same holds for reactions added later: a new subscriber does not see
 * already-dispatched history; replay is a read-model concern, not a
 * bus feature.
 */
export function eventBusSink<Evt extends AnyDomainEvent>(
	bus: EventBus<Evt>,
): OutboxSink<Evt> {
	return {
		publish: (record, context) =>
			bus.publish([record.event], {
				signal: context.signal,
				timeoutMs: Math.max(0, context.deadlineAt - Date.now()),
			}),
	};
}

/** Construction options for {@link OutboxDispatcher}. */
export interface OutboxDispatcherOptions<Evt extends AnyDomainEvent> {
	/**
	 * The poll surface. Pass a {@link DispatchTrackingOutbox} to get
	 * bounded retries: the dispatcher reports each delivery failure via
	 * `markFailed`, and the store dead-letters records past its attempt
	 * ceiling so a poison message stops blocking the queue. With a plain
	 * {@link Outbox}, a poison message retries forever, rate-limited by
	 * the backoff ceiling (documented trade-off; prefer the tracking
	 * port in production).
	 *
	 * The tracking capability is detected STRUCTURALLY at runtime
	 * (`markFailed` and `deadLetters` both present). A wrapper or
	 * decorator around a tracking outbox must forward both methods;
	 * one that exposes only the plain `Outbox` surface silently turns
	 * bounded retries off.
	 */
	outbox: Outbox<Evt> | DispatchTrackingOutbox<Evt>;

	/** Where events go; see {@link OutboxSink}. */
	sink: OutboxSink<Evt>;

	/**
	 * Complete, required operational observer bundle. A plain `Outbox` never
	 * calls `onDeadLetter`, but the complete bundle remains required so changing
	 * the adapter to a tracking outbox cannot silently omit the alarm path.
	 */
	observers: OutboxDispatcherObservers<Evt>;

	/** Records fetched per poll. Default `32`. */
	batchSize?: number;

	/** Idle sleep between polls when the outbox is empty. Default `250`ms. */
	pollIntervalMs?: number;

	/**
	 * First backoff delay after a failure; grows exponentially with the
	 * failing record's attempt count or the dispatcher's own
	 * consecutive-failure streak (whichever is larger, so the delay grows
	 * even when the store does not track attempts) and is jittered.
	 * Default `50`ms.
	 */
	baseDelayMs?: number;

	/** Ceiling for the failure backoff. Default `5000`ms. */
	maxDelayMs?: number;

	/**
	 * Maximum time to await one sink publication. The sink receives the same
	 * deadline as an AbortSignal and an absolute `deadlineAt`. Default `30000`ms.
	 */
	deliveryTimeoutMs?: number;

	/**
	 * Jitter source for the failure backoff, injectable for deterministic
	 * tests. Default `Math.random`.
	 */
	random?: () => number;

	/**
	 * Classifies a delivery failure before it is reported to a tracking
	 * outbox's `markFailed`: return `false` for failures that must NOT
	 * count toward the attempt ceiling (the broker is down, a DNS blip),
	 * `true` for genuine poison suspects (serialization failure,
	 * permanent rejection). Default: every failure counts.
	 *
	 * The trade-off of the default: a transport outage that outlasts
	 * roughly `ceiling x maxDelayMs` dead-letters HEALTHY head records
	 * one after another, and they wait in `deadLetters()` for manual
	 * redelivery, the exact loss the outbox exists to prevent. Size the
	 * store's ceiling for the longest outage you tolerate, or classify
	 * here. Failures classified as not counting still grow the
	 * consecutive-failure backoff; they just never dead-letter.
	 *
	 * Observer-grade robustness: a throwing classifier is treated as
	 * `true` (the failure counts) and cannot break the loop.
	 */
	countsTowardCeiling?: (error: unknown) => boolean;
}

/**
 * Minimal polling dispatcher over the {@link Outbox} poll surface: the
 * delivery half of the transactional outbox for setups that do not plug
 * in an external delivery solution (see the outbox guide, "External
 * dispatchers", for that path). Intended for tests, moduliths without a
 * broker, and single-process deployments; it is deliberately a loop
 * over the kit's own port, not a messaging framework.
 *
 * Contract:
 *
 * - **At-least-once.** `markDispatched` runs only AFTER successful
 *   `sink.publish` calls (the delivered prefix of a batch is acked in
 *   one call); a crash or a failed ack between publish and ack
 *   redelivers. Sinks and subscribers dedupe on `eventId` or the
 *   full gap-proof commit cursor
 *   (`domain-event-design.md`).
 * - **Sequential, stop-on-failure.** Records dispatch one at a time in
 *   commit order, and the first failure stops the batch: continuing
 *   past a failed event would break the per-aggregate causal order
 *   `withCommit` promises subscribers. The price is head-of-line
 *   blocking; the escape is the tracking outbox's attempt ceiling,
 *   which dead-letters a poison record so the queue flows again.
 * - **Never rejects, always backs off.** Storage errors from
 *   `getPending` and `markDispatched` are reported to the observers and
 *   absorbed; every failed cycle grows the backoff (per the failing
 *   record's attempts or the dispatcher's consecutive-failure streak)
 *   toward `maxDelayMs`, so a persistent fault degrades to a slow,
 *   observable retry cadence instead of a hot loop or a dead loop.
 * - **Bounded retries only with tracking.** With a
 *   {@link DispatchTrackingOutbox}, every delivery failure that
 *   {@link OutboxDispatcherOptions.countsTowardCeiling} classifies as
 *   counting (the default: all of them) is reported via `markFailed`;
 *   the store owns the ceiling and the dead-letter set (wire
 *   `deadLetters()` to alerting). An ack failure
 *   (`markDispatched` throwing) is NOT reported as a delivery failure:
 *   the events were delivered, and counting them toward the poison
 *   ceiling would dead-letter healthy records; they surface via
 *   `onDispatchError`, once per record of the delivered prefix (every
 *   one of them will redeliver), and a persistent ack fault is an
 *   operational incident the observer makes visible on every cycle.
 * - **One logical instance per outbox** unless the adapter's
 *   `getPending` claims records (see the port contract). The dispatcher
 *   itself adds no cross-instance coordination.
 * - **Graceful stop.** `run(signal)` resolves (never rejects) when the
 *   signal fires: mid-sleep immediately, mid-batch after the in-flight
 *   record settles.
 *
 * For cron triggers and serverless runtimes, use {@link drainOnce} per
 * tick instead of the long-running `run`.
 *
 * @example
 * ```ts
 * const dispatcher = new OutboxDispatcher({
 *   outbox,
 *   sink,
 *   observers: {
 *     onDispatchError: (error, record) =>
 *       log.warn({ error, eventId: record.event.eventId }, "dispatch failed"),
 *     onPollError: (error) => log.warn({ error }, "outbox poll failed"),
 *     onDeadLetter: (record) =>
 *       alerts.page({ eventId: record.event.eventId }, "outbox dead letter"),
 *   },
 * });
 * const stop = new AbortController();
 * void dispatcher.run(stop.signal);
 * // on shutdown:
 * stop.abort();
 * ```
 */
export class OutboxDispatcher<Evt extends AnyDomainEvent> extends PollLoop {
	private readonly outbox: Outbox<Evt> | DispatchTrackingOutbox<Evt>;
	private readonly sink: OutboxSink<Evt>;
	private readonly countsTowardCeiling?: (error: unknown) => boolean;
	private readonly observers: OutboxDispatcherObservers<Evt>;
	private readonly deliveryTimeoutMs: number;

	/**
	 * Whether the outbox passed at construction implements the
	 * dispatch-tracking protocol (`markFailed` AND `deadLetters`), i.e.
	 * whether bounded retries and dead-lettering are active. Detection
	 * is structural and happens ONCE, here. Assert this in your wiring
	 * tests: a decorator that forwards only the plain `Outbox` methods
	 * silently turns tracking off, and this flag is where that loss
	 * becomes visible instead of surfacing as an endless poison retry.
	 */
	readonly usesDispatchTracking: boolean;

	/** The tracking view of the outbox, when it qualifies (see above). */
	private readonly trackingOutbox?: DispatchTrackingOutbox<Evt>;

	constructor(options: OutboxDispatcherOptions<Evt>) {
		super("OutboxDispatcher", options);
		this.observers = captureObserverFunctions(
			"OutboxDispatcher",
			options.observers,
			["onDispatchError", "onPollError", "onDeadLetter"],
		);
		this.outbox = options.outbox;
		this.trackingOutbox = isDispatchTrackingOutbox(options.outbox)
			? options.outbox
			: undefined;
		this.usesDispatchTracking = this.trackingOutbox !== undefined;
		this.sink = options.sink;
		this.countsTowardCeiling = options.countsTowardCeiling;
		this.deliveryTimeoutMs =
			options.deliveryTimeoutMs ?? DEFAULT_EFFECT_TIMEOUT_MS;
		assertNonNegativeFinite(
			"OutboxDispatcher",
			"deliveryTimeoutMs",
			this.deliveryTimeoutMs,
		);
	}

	/**
	 * One full dispatch pass (the `run`/`drainOnce` shell lives on
	 * {@link PollLoop}): dispatches pending records batch by batch until
	 * the backlog is empty or a failure stops progress. A `"stopped"`
	 * pass leaves the failed record pending (or dead-lettered by a
	 * tracking outbox); the next cycle retries it.
	 */
	protected async pass(signal?: AbortSignal): Promise<"drained" | "stopped"> {
		while (!signal?.aborted) {
			let batch: ReadonlyArray<OutboxRecord<Evt>>;
			try {
				batch = await this.outbox.getPending(this.batchSize);
			} catch (error) {
				this.consecutiveFailures += 1;
				reportToObserver(() => this.observers.onPollError(error));
				return "stopped";
			}
			if (batch.length === 0) {
				// An empty backlog is proof of a healthy state: reset the
				// failure streak so the next, unrelated failure starts its
				// backoff at attempt 1 instead of inheriting an old streak
				// (e.g. after the store dead-lettered a poison record).
				this.consecutiveFailures = 0;
				return "drained";
			}
			const completed = await this.dispatchBatch(batch, signal);
			if (!completed) return "stopped";
		}
		return "stopped";
	}

	/**
	 * Applies the `countsTowardCeiling` classifier with observer-grade
	 * robustness: no classifier or a throwing classifier means the
	 * failure counts (the safe default; an uncounted poison record would
	 * retry forever).
	 */
	private failureCountsTowardCeiling(error: unknown): boolean {
		if (this.countsTowardCeiling === undefined) return true;
		try {
			return this.countsTowardCeiling(error);
		} catch {
			return true;
		}
	}

	/**
	 * Dispatches one batch sequentially and acks the delivered prefix in
	 * a single `markDispatched` call. Returns `true` when every record
	 * was delivered and acked, `false` when the pass stopped early
	 * (publish failure, ack failure, or abort).
	 */
	private async dispatchBatch(
		batch: ReadonlyArray<OutboxRecord<Evt>>,
		signal?: AbortSignal,
	): Promise<boolean> {
		const delivered: string[] = [];
		let failedRecord: OutboxRecord<Evt> | undefined;
		let failure: unknown;
		for (const record of batch) {
			if (signal?.aborted) break;
			try {
				await runBoundedEffect(
					"OutboxDispatcher.publish",
					{ signal, timeoutMs: this.deliveryTimeoutMs },
					(context) => this.sink.publish(record, context),
				);
				delivered.push(record.dispatchId);
			} catch (error) {
				if (signal?.aborted) {
					break;
				}
				failedRecord = record;
				failure = error;
				break;
			}
		}

		// Ack the delivered prefix in one round-trip, before handling the
		// failure, so delivered records do not redeliver.
		let acked = true;
		if (delivered.length > 0) {
			try {
				await this.outbox.markDispatched(delivered);
				this.consecutiveFailures = 0;
			} catch (error) {
				// The events WERE delivered; a failed ack means they will
				// redeliver (the documented at-least-once duplicates), so it
				// must not count toward the poison ceiling. The growing
				// consecutive-failure backoff rate-limits the duplicates.
				// Every record in the delivered prefix is affected; report
				// each one, so the operator can match the coming duplicates
				// to this ack failure instead of chasing them individually.
				acked = false;
				for (const context of batch.slice(0, delivered.length)) {
					reportToObserver(() =>
						this.observers.onDispatchError(error, context),
					);
				}
			}
		}

		if (failedRecord !== undefined) {
			const record = failedRecord;
			const error = failure;
			reportToObserver(() => this.observers.onDispatchError(error, record));
			const tracking = this.trackingOutbox;
			if (tracking !== undefined && this.failureCountsTowardCeiling(error)) {
				try {
					const deadLetter = await tracking.markFailed(
						record.dispatchId,
						error,
					);
					if (deadLetter !== undefined) {
						reportToObserver(() => this.observers.onDeadLetter(deadLetter));
					}
				} catch (markError) {
					reportToObserver(() =>
						this.observers.onDispatchError(markError, record),
					);
				}
			}
		}

		// One streak bump per failed cycle, whatever combination of ack and
		// publish failures occurred, so the backoff grows exactly one
		// exponential step per cycle as documented.
		if (failedRecord !== undefined || !acked) {
			this.consecutiveFailures = Math.max(
				this.consecutiveFailures + 1,
				(failedRecord?.attempts ?? 0) + 1,
			);
		}
		if (failedRecord !== undefined) return false;
		if (!acked) return false;
		// An abort mid-batch left records unpublished; not a failure, but
		// not a completed batch either.
		if (signal?.aborted && delivered.length < batch.length) return false;
		return true;
	}
}
