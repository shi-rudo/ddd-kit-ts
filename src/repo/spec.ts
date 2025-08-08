/**
 * A Specification is a named, standalone object that represents a business rule for a query.
 * It is "translatable" into a concrete database query.
 */
export interface ISpecification<T> {
	// A marker interface to ensure type safety.
	// Concrete implementations add methods for translation.
	readonly _type: T; // For typing only, has no runtime value
}
