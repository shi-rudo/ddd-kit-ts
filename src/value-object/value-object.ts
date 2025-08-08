export type ValueObject<T> = Readonly<T>;
export function vo<T>(t: T): ValueObject<T> {
	return Object.freeze({ ...t });
}
