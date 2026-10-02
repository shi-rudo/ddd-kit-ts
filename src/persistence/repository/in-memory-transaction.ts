/**
 * The transaction of one registered store inside an
 * `InMemoryTransactionScope`. The scope ends it once, with `commit` or
 * `rollback`.
 */
export interface InMemoryTransaction {
	/**
	 * Ends the transaction and keeps its writes. It must not throw. If a commit
	 * throws, the scope still commits the other stores and rejects with the
	 * first failure, so the writes stay partly committed.
	 */
	commit(): void;
	/** Ends the transaction and undoes its writes. */
	rollback(): void;
}

/**
 * An in-memory store that you can register with an
 * `InMemoryTransactionScope`. The store prepares its rollback when a
 * transaction begins. The scope never reads the state of a store.
 */
export interface InMemoryTransactionParticipant {
	/** Begins a transaction. Only an `InMemoryTransactionScope` calls this method. */
	beginTransaction(): InMemoryTransaction;
}
