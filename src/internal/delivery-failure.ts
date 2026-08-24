/** Operational classification applied to one failed background delivery. */
export type DeliveryFailureKind = "transient" | "permanent" | "unknown";

/** Consumer-owned translation from an adapter error to delivery semantics. */
export type DeliveryFailureClassifier = (error: unknown) => DeliveryFailureKind;

/** Result of applying a delivery-failure classifier safely. */
export interface DeliveryFailureAssessment {
	/** How the shell will account for and recover from the failure. */
	readonly kind: DeliveryFailureKind;
	/** Classifier bug or invalid return value, when classification itself failed. */
	readonly classifierError?: unknown;
}

const KINDS = new Set<DeliveryFailureKind>([
	"transient",
	"permanent",
	"unknown",
]);

/**
 * Default delivery classification. A retryable marker anywhere in the cause
 * chain, or a native `TimeoutError`, is transient. An explicit
 * `retryable: false` marker is permanent. Unmapped errors stay unknown and use
 * the shell's safe accounting default.
 */
export function classifyDeliveryFailure(error: unknown): DeliveryFailureKind {
	let current = error;
	let sawNonRetryable = false;
	const seen = new Set<object>();

	while (
		current !== null &&
		(typeof current === "object" || typeof current === "function")
	) {
		const node = current as object;
		if (seen.has(node)) break;
		seen.add(node);

		try {
			const candidate = current as {
				readonly name?: unknown;
				readonly retryable?: unknown;
				readonly cause?: unknown;
			};
			if (candidate.name === "TimeoutError") return "transient";
			if (candidate.retryable === true) return "transient";
			if (candidate.retryable === false) sawNonRetryable = true;
			current = candidate.cause;
		} catch {
			return "unknown";
		}
	}

	return sawNonRetryable ? "permanent" : "unknown";
}

/** Applies a custom/default classifier without letting it break the worker. */
export function assessDeliveryFailure(
	error: unknown,
	classifier: DeliveryFailureClassifier = classifyDeliveryFailure,
): DeliveryFailureAssessment {
	try {
		const kind = classifier(error);
		if (KINDS.has(kind)) return Object.freeze({ kind });
		return Object.freeze({
			kind: "unknown",
			classifierError: new TypeError(
				`Delivery failure classifier returned invalid kind: ${String(kind)}`,
			),
		});
	} catch (classifierError) {
		return Object.freeze({ kind: "unknown", classifierError });
	}
}
