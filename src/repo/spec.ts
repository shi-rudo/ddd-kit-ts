declare const __specBrand: unique symbol;

/**
 * A Specification is a named, standalone object that represents a business rule for a query.
 * It is "translatable" into a concrete database query.
 *
 * Uses a branded type to carry the generic parameter without requiring
 * implementors to add a runtime field.
 */
export interface ISpecification<T> {
	readonly [__specBrand]?: T;
}
