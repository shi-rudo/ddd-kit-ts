import { ValidationError } from "@shirudo/base-error";
import {
	LocalizedMessageSet,
	project,
} from "@shirudo/base-error/public-error";
import { describe, expect, it } from "vitest";
import {
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DomainError,
} from "../core/errors";
import { createKitPublicErrors } from "./kit-public-errors";
import { toPublicErrorView } from "./public-error-view";

class OrderAlreadyShippedError extends DomainError<"ORDER_ALREADY_SHIPPED"> {
	constructor(orderId: string) {
		super({
			code: "ORDER_ALREADY_SHIPPED",
			message: `Order ${orderId} has already been shipped`,
		});
	}
}

describe("createKitPublicErrors catalog", () => {
	const kitPublicErrors = createKitPublicErrors();

	it("carries transport metadata for the kit's public codes", () => {
		expect(kitPublicErrors.transportFor("AGGREGATE_NOT_FOUND")?.status).toBe(
			404,
		);
		expect(kitPublicErrors.transportFor("CONCURRENCY_CONFLICT")?.status).toBe(
			409,
		);
		expect(kitPublicErrors.transportFor("DUPLICATE_AGGREGATE")?.status).toBe(
			409,
		);
		expect(kitPublicErrors.transportFor("VALIDATION_FAILED")?.status).toBe(
			422,
		);
		expect(kitPublicErrors.fallback.publicCode).toBe("INTERNAL_ERROR");
		expect(kitPublicErrors.fallback.status).toBe(500);
	});

	it("projects kit errors by their code, carrying the retryable hint", () => {
		const view = project(
			kitPublicErrors,
			new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 1,
				actualVersion: 2,
			}),
		);

		expect(view.code).toBe("CONCURRENCY_CONFLICT");
		expect(view.retryable).toBe(true);
	});

	it("projects a ValidationError with sanitized issues under details", () => {
		const error = new ValidationError("invalid").addIssues([
			{ message: "must be a valid email", path: ["email"] },
		]);

		const view = project(kitPublicErrors, error);

		expect(view.code).toBe("VALIDATION_FAILED");
		const details = view.details as { issues: Array<{ message: string }> };
		expect(details.issues).toHaveLength(1);
		expect(details.issues[0]?.message).toBe("must be a valid email");
	});

	it("degrades unknown errors to the INTERNAL_ERROR fallback", () => {
		const view = project(kitPublicErrors, new Error("pg pool exhausted"));

		expect(view.code).toBe("INTERNAL_ERROR");
		expect(view.details).toBeUndefined();
	});

	it("consumers extend their own factory instance; other instances stay untouched", () => {
		const extended = createKitPublicErrors().registerByCode("ORDER_ALREADY_SHIPPED", {
			publicCode: "ORDER_ALREADY_SHIPPED",
			status: 409,
			userMessages: new LocalizedMessageSet({
				baseLocale: "en",
				messages: { en: "This order has already been shipped." },
			}),
		});

		const consumerError = new OrderAlreadyShippedError("o-1");

		expect(project(extended, consumerError).code).toBe(
			"ORDER_ALREADY_SHIPPED",
		);
		// A fresh kit catalog is untouched: the same error falls back there.
		expect(project(createKitPublicErrors(), consumerError).code).toBe(
			"INTERNAL_ERROR",
		);
	});

	it("toPublicErrorView accepts an extended catalog", () => {
		const extended = createKitPublicErrors().registerByCode("ORDER_ALREADY_SHIPPED", {
			publicCode: "ORDER_ALREADY_SHIPPED",
			status: 409,
			userMessages: new LocalizedMessageSet({
				baseLocale: "en",
				messages: {
					en: "This order has already been shipped.",
					de: "Diese Bestellung wurde bereits versandt.",
				},
			}),
		});

		const view = toPublicErrorView(new OrderAlreadyShippedError("o-1"), {
			locale: "de-DE",
			catalog: extended,
		});

		expect(view.code).toBe("ORDER_ALREADY_SHIPPED");
		expect(view.message).toBe("Diese Bestellung wurde bereits versandt.");
		expect(view.locale).toBe("de");
	});

	it("kit errors keep their safe views through the default delegation", () => {
		const view = toPublicErrorView(
			new AggregateNotFoundError({ aggregateType: "Order", id: "o-1" }),
		);

		expect(view.code).toBe("AGGREGATE_NOT_FOUND");
		expect(view.message).toBe("The requested resource could not be found.");
		expect(view.locale).toBe("en");
	});
});
