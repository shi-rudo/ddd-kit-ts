/**
 * Branded string ID. `Tag` carries the aggregate / entity name so two ids
 * with different tags are not assignable to each other even though both
 * are strings at runtime.
 *
 * @example
 * ```ts
 * type UserId = Id<"UserId">;
 * type OrderId = Id<"OrderId">;
 *
 * const u = "user-1" as UserId;
 * const o: OrderId = u; // ❌ compile error
 * ```
 */
export type Id<Tag extends string> = string & { readonly __brand: Tag };

/**
 * Produces fresh ids of a single, fixed tag. The tag is bound at the
 * generator type — `IdGenerator<"UserId">.next()` returns `Id<"UserId">`
 * with no caller-side generic to abuse.
 *
 * @example
 * ```ts
 * import { ulid } from "ulid";
 *
 * const userIds: IdGenerator<"UserId"> = { next: () => ulid() as Id<"UserId"> };
 * const id = userIds.next(); // Id<"UserId">
 * ```
 *
 * The previous shape (`IdGenerator { next<T extends string>(): Id<T> }`)
 * let callers pick `T` themselves — `gen.next<"AnyTag">()` typechecked
 * even when the generator produced different-tag ids, silently defeating
 * the brand.
 */
export interface IdGenerator<Tag extends string> {
	next: () => Id<Tag>;
}
