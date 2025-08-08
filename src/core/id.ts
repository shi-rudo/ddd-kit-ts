export type Id<Tag extends string> = string & { readonly __brand: Tag };
export interface IdGenerator {
	next: <T extends string>() => Id<T>;
}
