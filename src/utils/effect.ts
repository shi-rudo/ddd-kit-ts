import { abortReason } from "./abort";
import { assertNonNegativeFinite } from "./validate";

/** Context handed to one imperative-shell effect. */
export interface EffectContext {
	/** Cooperative cancellation for the in-flight effect. */
	readonly signal: AbortSignal;
	/** Absolute Unix epoch millisecond at which the shell times the effect out. */
	readonly deadlineAt: number;
}

/** Caller controls for one bounded imperative-shell effect. */
type EffectOptions =
	| {
			/** Optional owner/request cancellation signal. */
			readonly signal?: AbortSignal;
			/** Maximum time the shell waits for the effect. */
			readonly timeoutMs: number;
			readonly deadlineAt?: never;
	  }
	| {
			/** Optional owner/request cancellation signal. */
			readonly signal?: AbortSignal;
			readonly timeoutMs?: never;
			/** Shared absolute deadline for a multi-effect budget. */
			readonly deadlineAt: number;
	  };

/** Default bound for delivery and post-commit effects. */
export const DEFAULT_EFFECT_TIMEOUT_MS = 30_000;

/**
 * Runs one effect with a child signal that combines owner cancellation and a
 * shell-owned timeout. The returned promise settles on abort even when an
 * adapter ignores the signal; the adapter promise remains observed so a later
 * rejection cannot become an unhandled rejection.
 *
 * This bounds how long the shell waits; JavaScript cannot forcibly terminate
 * an arbitrary promise. An I/O adapter that must prevent zombie work and
 * overlapping retries has to pass `context.signal` to its native operation or
 * enforce a native timeout no later than `context.deadlineAt`.
 */
export function runBoundedEffect<T>(
	label: string,
	options: EffectOptions,
	effect: (context: EffectContext) => Promise<T> | T,
): Promise<T> {
	if (options.deadlineAt === undefined) {
		assertNonNegativeFinite(label, "timeoutMs", options.timeoutMs);
	} else {
		assertNonNegativeFinite(label, "deadlineAt", options.deadlineAt);
	}
	const startedAt = Date.now();
	const deadlineAt = options.deadlineAt ?? startedAt + options.timeoutMs;
	const timeoutMs = Math.max(0, deadlineAt - startedAt);
	const timeoutError = (): DOMException =>
		new DOMException(`${label} timed out after ${timeoutMs}ms`, "TimeoutError");
	const controller = new AbortController();
	const context = Object.freeze({
		signal: controller.signal,
		deadlineAt,
	});
	const ownerSignal = options.signal;
	const abortFromOwner = (): void => {
		controller.abort(
			ownerSignal === undefined
				? new Error(`${label} aborted`)
				: abortReason(ownerSignal, `${label} aborted`),
		);
	};

	if (ownerSignal?.aborted) abortFromOwner();
	else ownerSignal?.addEventListener("abort", abortFromOwner, { once: true });
	if (
		!controller.signal.aborted &&
		options.deadlineAt !== undefined &&
		deadlineAt <= startedAt
	) {
		controller.abort(timeoutError());
	}

	const timer = setTimeout(() => {
		controller.abort(timeoutError());
	}, timeoutMs);

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (complete: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			ownerSignal?.removeEventListener("abort", abortFromOwner);
			controller.signal.removeEventListener("abort", onAbort);
			complete();
		};
		const onAbort = (): void => {
			// Defer one microtask so a promise that settled immediately before the
			// abort keeps its acknowledgement semantics. If abort happened first,
			// this microtask was queued first and still wins deterministically.
			queueMicrotask(() =>
				finish(() =>
					reject(abortReason(controller.signal, `${label} aborted`)),
				),
			);
		};

		if (controller.signal.aborted) {
			onAbort();
			return;
		}
		controller.signal.addEventListener("abort", onAbort, { once: true });
		let outcome: Promise<T>;
		try {
			outcome = Promise.resolve(effect(context));
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		outcome.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}
