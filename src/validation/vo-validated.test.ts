import { ValidationError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import { voValidated } from "./vo-validated";

interface RegistrationProps {
	email: string;
	age: number;
}

const isEmail = (s: string) => /.+@.+/.test(s);

const checkRegistration = (
	issues: ValidationError,
	m: RegistrationProps,
): void => {
	if (!isEmail(m.email))
		issues.addIssue({ message: "must be a valid email", path: ["email"] });
	if (m.age < 0)
		issues.addIssue({ message: "must not be negative", path: ["age"] });
};

describe("voValidated()", () => {
	it("returns Ok with a deeply frozen value object when all rules pass", () => {
		const result = voValidated<RegistrationProps>(
			{ email: "a@b.com", age: 30 },
			checkRegistration,
		);

		expect(result.isOk()).toBe(true);
		if (result.isOk()) {
			expect(result.value.email).toBe("a@b.com");
			expect(() => {
				(result.value as { email: string }).email = "x";
			}).toThrow();
		}
	});

	it("collects ALL field violations into a single ValidationError", () => {
		const result = voValidated<RegistrationProps>(
			{ email: "nope", age: -1 },
			checkRegistration,
		);

		expect(result.isErr()).toBe(true);
		if (result.isErr()) {
			expect(result.error).toBeInstanceOf(ValidationError);
			const issues = result.error.publicIssues();
			expect(issues).toHaveLength(2);
			expect(issues.map((i) => i.message)).toEqual([
				"must be a valid email",
				"must not be negative",
			]);
		}
	});

	it("uses a custom aggregate message and defaults otherwise", () => {
		const custom = voValidated(
			{ email: "nope" },
			(issues) => issues.addIssue({ message: "bad", path: ["email"] }),
			"Registration is invalid",
		);
		expect(custom.isErr() && custom.error.message).toBe(
			"Registration is invalid",
		);

		const fallback = voValidated({ email: "nope" }, (issues) =>
			issues.addIssue({ message: "bad", path: ["email"] }),
		);
		expect(fallback.isErr() && fallback.error.message).toBe(
			"Validation failed",
		);
	});

	it("does not freeze the caller's input on success", () => {
		const input = { email: "a@b.com", nested: { x: 1 } };
		const result = voValidated(input, () => {});

		expect(result.isOk()).toBe(true);
		input.nested.x = 2;
		expect(input.nested.x).toBe(2);
	});
});
