/**
 * The composite structure of a combinator-built specification, exposed
 * for adapters that translate specifications into storage queries. An
 * adapter walks `composite` recursively down to the named leaves and
 * translates each one. This is deliberately not an expression tree:
 * predicates stay opaque functions, and only the boolean structure and
 * the leaf names are visible from outside.
 */
export type SpecificationComposite<T> =
	| {
			readonly operator: "and";
			readonly left: Specification<T>;
			readonly right: Specification<T>;
	  }
	| {
			readonly operator: "or";
			readonly left: Specification<T>;
			readonly right: Specification<T>;
	  }
	| { readonly operator: "not"; readonly inner: Specification<T> };

/**
 * Specification: a named, executable domain criterion (Evans/Fowler).
 * "Which candidates qualify?" becomes an object in the ubiquitous
 * language instead of an inline predicate or a leaked query builder:
 * `overdueInvoices.and(highValue.not())` reads like the business rule
 * it encodes, evaluates in memory via {@link isSatisfiedBy}, and can be
 * translated by a repository adapter into its storage's query language.
 *
 * The same object serves three places. Domain logic calls
 * `spec.isSatisfiedBy(candidate)` directly. An in-memory repository or
 * test fake implements its lookup as a plain filter,
 * `rows.filter((r) => spec.isSatisfiedBy(r))`, with no translation
 * layer. And a storage adapter translates leaf specifications
 * explicitly (matching on {@link name}, or narrowing to the class for
 * parameterized leaves) while recursing through {@link composite} for
 * combinator nodes; the repository guide walks through it. The kit
 * ships this convention and deliberately no translation machinery:
 * no expression trees, no LINQ-style providers.
 *
 * The class is deliberately left open: the combinators can be
 * overridden and `composite` can be set by subclasses. That is what
 * makes a classic visitor/double-dispatch layer buildable on top,
 * for consumers who want the compiler to enforce translation
 * completeness across several targets; the repository guide's
 * "A visitor layer on top" section shows the full construction.
 *
 * Take the name from the ubiquitous language. It is what an adapter
 * matches on, what diagnostics print, and what ties the object back to
 * the rule as the domain expert stated it. If no expert would
 * recognize the name, what you have is a code predicate, not a
 * specification.
 *
 * Subclass for parameterized specifications, or use the
 * {@link specification} factory for flat ones:
 *
 * @example
 * ```typescript
 * class OverdueInvoice extends Specification<Invoice> {
 *   readonly name = "overdue invoice";
 *   constructor(private readonly today: Date) { super(); }
 *   isSatisfiedBy(invoice: Invoice): boolean {
 *     return invoice.dueDate < this.today && invoice.status === "open";
 *   }
 * }
 *
 * const dunningCandidates = new OverdueInvoice(today)
 *   .and(specification("in dunning grace period", (i: Invoice) =>
 *     i.remindersSent < 3,
 *   ));
 * ```
 */
export abstract class Specification<T> {
	/**
	 * The ubiquitous-language name of the criterion. Leaf names are what
	 * adapters translate and diagnostics print; combinator nodes derive
	 * theirs (`"(a and b)"`, `"(not a)"`).
	 */
	abstract readonly name: string;

	/**
	 * The composite structure for combinator-built specifications;
	 * `undefined` on leaves. See {@link SpecificationComposite}.
	 */
	readonly composite?: SpecificationComposite<T>;

	/** In-memory evaluation: does `candidate` meet the criterion? */
	abstract isSatisfiedBy(candidate: T): boolean;

	/** Both criteria must hold (short-circuits like `&&`). */
	and(other: Specification<T>): Specification<T> {
		return new BinaryCompositeSpecification("and", this, other);
	}

	/** Either criterion suffices (short-circuits like `||`). */
	or(other: Specification<T>): Specification<T> {
		return new BinaryCompositeSpecification("or", this, other);
	}

	/** The criterion must not hold. */
	not(): Specification<T> {
		return new NotSpecification(this);
	}

	/** The name, so diagnostics and test output read in domain language. */
	toString(): string {
		return this.name;
	}
}

/**
 * Builds a leaf specification from a name and a predicate: the
 * lightweight alternative to subclassing for criteria without
 * parameters worth a class of their own. The predicate must be pure
 * (no side effects, no mutation of the candidate): specifications are
 * evaluated freely and repeatedly, in tests, combinators, and
 * in-memory repositories.
 */
export function specification<T>(
	name: string,
	predicate: (candidate: T) => boolean,
): Specification<T> {
	if (name.trim().length === 0 || name !== name.trim()) {
		throw new Error(
			"specification: the name must be a non-empty ubiquitous-language term " +
				"without leading or trailing whitespace; adapters match it as an " +
				"exact string, and padding is invisible in every diagnostic",
		);
	}
	return new PredicateSpecification(name, predicate);
}

class PredicateSpecification<T> extends Specification<T> {
	constructor(
		readonly name: string,
		private readonly predicate: (candidate: T) => boolean,
	) {
		super();
	}

	isSatisfiedBy(candidate: T): boolean {
		return this.predicate(candidate);
	}
}

class BinaryCompositeSpecification<T> extends Specification<T> {
	override readonly composite: {
		readonly operator: "and" | "or";
		readonly left: Specification<T>;
		readonly right: Specification<T>;
	};
	private cachedName?: string;

	constructor(
		operator: "and" | "or",
		left: Specification<T>,
		right: Specification<T>,
	) {
		super();
		// Frozen like every plain object the kit hands out: readonly is
		// compile-time only, and an adapter mutating the structure would
		// silently diverge from name and evaluation.
		this.composite = Object.freeze({ operator, left, right });
	}

	// Lazy with a cache: deep chains would otherwise pay quadratic
	// string work at construction for names only diagnostics read.
	get name(): string {
		this.cachedName ??= `(${this.composite.left.name} ${this.composite.operator} ${this.composite.right.name})`;
		return this.cachedName;
	}

	isSatisfiedBy(candidate: T): boolean {
		const { operator, left, right } = this.composite;
		return operator === "and"
			? left.isSatisfiedBy(candidate) && right.isSatisfiedBy(candidate)
			: left.isSatisfiedBy(candidate) || right.isSatisfiedBy(candidate);
	}
}

class NotSpecification<T> extends Specification<T> {
	override readonly composite: {
		readonly operator: "not";
		readonly inner: Specification<T>;
	};
	private cachedName?: string;

	constructor(inner: Specification<T>) {
		super();
		this.composite = Object.freeze({ operator: "not", inner });
	}

	get name(): string {
		this.cachedName ??= `(not ${this.composite.inner.name})`;
		return this.cachedName;
	}

	isSatisfiedBy(candidate: T): boolean {
		return !this.composite.inner.isSatisfiedBy(candidate);
	}
}
