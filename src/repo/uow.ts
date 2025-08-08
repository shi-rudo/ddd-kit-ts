export interface UnitOfWork {
	transactional<T>(fn: () => Promise<T>): Promise<T>;
}
export type RepoProvider<R> = (uow: UnitOfWork) => R;
