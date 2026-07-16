import { describe, expect, it } from "vite-plus/test";
import { Specification, specification } from "./specification";

interface Invoice {
	status: "open" | "paid";
	dueDate: string;
	total: number;
	remindersSent: number;
}

const invoice = (overrides: Partial<Invoice> = {}): Invoice => ({
	status: "open",
	dueDate: "2026-01-01",
	total: 100,
	remindersSent: 0,
	...overrides,
});

const overdue = specification<Invoice>(
	"overdue",
	(i) => i.status === "open" && i.dueDate < "2026-07-01",
);
const highValue = specification<Invoice>("high value", (i) => i.total >= 1000);

describe("specification factory", () => {
	it("evaluates the predicate and carries the ubiquitous-language name", () => {
		expect(overdue.name).toBe("overdue");
		expect(overdue.isSatisfiedBy(invoice())).toBe(true);
		expect(overdue.isSatisfiedBy(invoice({ status: "paid" }))).toBe(false);
		expect(String(overdue)).toBe("overdue");
	});

	it("rejects empty, blank, and whitespace-padded names", () => {
		expect(() => specification("", () => true)).toThrow(/non-empty/);
		expect(() => specification("   ", () => true)).toThrow(/non-empty/);
		// Padding passes an eyeball check but never matches an adapter's
		// exact-string leaf switch; reject it at construction.
		expect(() => specification("overdue ", () => true)).toThrow(/whitespace/);
		expect(() => specification(" overdue", () => true)).toThrow(/whitespace/);
	});

	it("is a leaf: no composite structure", () => {
		expect(overdue.composite).toBeUndefined();
	});
});

describe("subclassed specifications", () => {
	class MinimumTotal extends Specification<Invoice> {
		readonly name = "minimum total";
		constructor(private readonly threshold: number) {
			super();
		}
		isSatisfiedBy(candidate: Invoice): boolean {
			return candidate.total >= this.threshold;
		}
	}

	it("parameterized subclasses evaluate and combine like factory-built ones", () => {
		const spec = new MinimumTotal(500).and(overdue);
		expect(spec.isSatisfiedBy(invoice({ total: 500 }))).toBe(true);
		expect(spec.isSatisfiedBy(invoice({ total: 499 }))).toBe(false);
		expect(spec.name).toBe("(minimum total and overdue)");
	});
});

describe("combinators", () => {
	it("and requires both", () => {
		const spec = overdue.and(highValue);
		expect(spec.isSatisfiedBy(invoice({ total: 1500 }))).toBe(true);
		expect(spec.isSatisfiedBy(invoice({ total: 10 }))).toBe(false);
		expect(spec.isSatisfiedBy(invoice({ status: "paid", total: 1500 }))).toBe(
			false,
		);
	});

	it("or accepts either", () => {
		const spec = overdue.or(highValue);
		expect(spec.isSatisfiedBy(invoice({ status: "paid", total: 1500 }))).toBe(
			true,
		);
		expect(spec.isSatisfiedBy(invoice({ total: 10 }))).toBe(true);
		expect(spec.isSatisfiedBy(invoice({ status: "paid", total: 10 }))).toBe(
			false,
		);
	});

	it("not inverts, and a double not restores the original verdict", () => {
		expect(overdue.not().isSatisfiedBy(invoice())).toBe(false);
		expect(overdue.not().isSatisfiedBy(invoice({ status: "paid" }))).toBe(true);
		expect(overdue.not().not().isSatisfiedBy(invoice())).toBe(true);
	});

	it("derives readable names from the ubiquitous-language leaves", () => {
		expect(overdue.and(highValue.not()).name).toBe(
			"(overdue and (not high value))",
		);
		expect(overdue.or(highValue).not().name).toBe(
			"(not (overdue or high value))",
		);
	});

	it("short-circuits like the boolean operators it mirrors", () => {
		let rightEvaluated = 0;
		const counting = specification<Invoice>("counting", () => {
			rightEvaluated += 1;
			return true;
		});

		overdue.and(counting).isSatisfiedBy(invoice({ status: "paid" }));
		expect(rightEvaluated).toBe(0);
		overdue.or(counting).isSatisfiedBy(invoice());
		expect(rightEvaluated).toBe(0);
	});
});

describe("composite introspection for adapter translation", () => {
	it("hands out frozen composites: an adapter cannot mutate the structure", () => {
		const spec = overdue.and(highValue);
		expect(Object.isFrozen(spec.composite)).toBe(true);
		expect(Object.isFrozen(overdue.not().composite)).toBe(true);
		expect(() => {
			// biome-ignore lint/suspicious/noExplicitAny: deliberate runtime mutation attempt
			(spec.composite as any).operator = "or";
		}).toThrow(TypeError);
	});

	it("exposes the boolean structure down to named leaves", () => {
		const spec = overdue.and(highValue.not());
		expect(spec.composite?.operator).toBe("and");
		if (spec.composite?.operator !== "and") throw new Error("narrowed above");
		expect(spec.composite.left.name).toBe("overdue");
		const right = spec.composite.right;
		expect(right.composite?.operator).toBe("not");
		if (right.composite?.operator !== "not") throw new Error("narrowed above");
		expect(right.composite.inner.name).toBe("high value");
		expect(right.composite.inner.composite).toBeUndefined();
	});

	it("supports the documented recursive translation walk", () => {
		// The guide's adapter shape: recurse through composites, translate
		// leaves by name, refuse unknown names loudly.
		const translate = (spec: Specification<Invoice>): string => {
			const composite = spec.composite;
			if (composite) {
				switch (composite.operator) {
					case "and":
						return `(${translate(composite.left)} AND ${translate(composite.right)})`;
					case "or":
						return `(${translate(composite.left)} OR ${translate(composite.right)})`;
					case "not":
						return `(NOT ${translate(composite.inner)})`;
				}
			}
			switch (spec.name) {
				case "overdue":
					return "status = 'open' AND due_date < $today";
				case "high value":
					return "total >= 1000";
				default:
					throw new Error(
						`No SQL translation for specification '${spec.name}'`,
					);
			}
		};

		expect(translate(overdue.and(highValue.not()))).toBe(
			"(status = 'open' AND due_date < $today AND (NOT total >= 1000))",
		);
		expect(() => translate(specification("unknown", () => true))).toThrow(
			/No SQL translation/,
		);
	});
});

describe("in-memory evaluation as findSatisfying", () => {
	it("an in-memory repository honors a specification with a one-line filter", () => {
		const rows = [
			invoice({ total: 1500 }),
			invoice({ status: "paid", total: 2000 }),
			invoice({ total: 10 }),
		];
		const findSatisfying = (spec: Specification<Invoice>): Invoice[] =>
			rows.filter((row) => spec.isSatisfiedBy(row));

		expect(findSatisfying(overdue.and(highValue))).toEqual([
			invoice({ total: 1500 }),
		]);
	});
});
