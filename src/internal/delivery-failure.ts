import { findInCauseChain } from "@shirudo/base-error";

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

interface FailureMarkers {
	readonly name?: unknown;
	readonly retryable?: unknown;
}

/**
 * Default delivery classification. The nearest error in the cause chain that
 * carries a `retryable` marker or is a native `TimeoutError` decides. So a
 * wrapper that marks a failure permanent wins over a retryable cause.
 * `retryable: true` and a `TimeoutError` are transient, `retryable: false` is
 * permanent. Unmapped errors stay unknown and use the shell's safe accounting
 * default.
 */
export function classifyDeliveryFailure(error: unknown): DeliveryFailureKind {
	const decisive = findInCauseChain(error, isDecisiveFailure) as
		| FailureMarkers
		| undefined;
	if (decisive === undefined) return "unknown";
	return decisive.retryable === false ? "permanent" : "transient";
}

function isDecisiveFailure(node: unknown): boolean {
	if (node === null || typeof node !== "object") return false;
	const { name, retryable } = node as FailureMarkers;
	return typeof retryable === "boolean" || name === "TimeoutError";
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
