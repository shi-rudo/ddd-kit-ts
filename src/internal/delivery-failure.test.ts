import { describe, expect, it } from "vite-plus/test";
import { classifyDeliveryFailure } from "./delivery-failure";

function failure(
	message: string,
	markers: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): Error {
	const { cause, ...rest } = markers;
	return Object.assign(new Error(message, { cause }), rest);
}

describe("classifyDeliveryFailure", () => {
	it("lets an outer retryable false win over a deeper retryable true", () => {
		const error = failure("rejected for good", {
			retryable: false,
			cause: failure("connection reset", { retryable: true }),
		});

		expect(classifyDeliveryFailure(error)).toBe("permanent");
	});

	it("lets an outer retryable true win over a deeper retryable false", () => {
		const error = failure("try again later", {
			retryable: true,
			cause: failure("validation failed", { retryable: false }),
		});

		expect(classifyDeliveryFailure(error)).toBe("transient");
	});

	it("takes the marker of a cause when the outer error carries none", () => {
		const error = failure("publish failed", {
			cause: failure("broker unavailable", { retryable: true }),
		});

		expect(classifyDeliveryFailure(error)).toBe("transient");
	});

	it("treats a native TimeoutError as transient", () => {
		const error = new DOMException("publish timed out", "TimeoutError");

		expect(classifyDeliveryFailure(error)).toBe("transient");
	});

	it("treats an error without a marker as unknown", () => {
		expect(classifyDeliveryFailure(new Error("unmapped"))).toBe("unknown");
	});

	it("treats a circular cause chain without a marker as unknown", () => {
		const first = new Error("first");
		const second = new Error("second", { cause: first });
		Object.assign(first, { cause: second });

		expect(classifyDeliveryFailure(second)).toBe("unknown");
	});
});
