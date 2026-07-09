/**
 * Opt-in testing entry point (`@shirudo/ddd-kit/testing`).
 *
 * Ships the adapter contract test suites (state-stored and
 * event-sourced repositories, outbox, idempotency store): the kit is
 * ORM- and store-agnostic, so optimistic concurrency, outbox
 * semantics, and the idempotency lifecycle are adapter CONTRACTS the
 * consumer's implementation must prove; this entry provides the proof
 * harnesses. Kept out of the core barrel so test-only code never rides
 * into production bundles. Named exports only; the shared suite
 * plumbing in contract-assertions stays internal.
 */
export {
	createDeadlineStoreContractTests,
	type DeadlineStoreContractEnvironment,
	type DeadlineStoreContractHarness,
	type DeadlineStoreContractTest,
} from "./testing/deadline-store-contract";
export {
	createEsRepositoryContractTests,
	type EsContractRepository,
	type EsRepositoryContractEnvironment,
	type EsRepositoryContractHarness,
	type EsRepositoryContractTest,
} from "./testing/es-repository-contract";
export {
	createIdempotencyStoreContractTests,
	type IdempotencyStoreContractEnvironment,
	type IdempotencyStoreContractHarness,
	type IdempotencyStoreContractTest,
} from "./testing/idempotency-store-contract";
export {
	createOutboxContractTests,
	type OutboxContractEnvironment,
	type OutboxContractHarness,
	type OutboxContractTest,
} from "./testing/outbox-contract";
export {
	createProjectionCheckpointStoreContractTests,
	type ProjectionCheckpointStoreContractEnvironment,
	type ProjectionCheckpointStoreContractHarness,
	type ProjectionCheckpointStoreContractTest,
} from "./testing/projection-checkpoint-contract";
export {
	type ContractRepository,
	createRepositoryContractTests,
	type RepositoryContractEnvironment,
	type RepositoryContractHarness,
	type RepositoryContractTest,
} from "./testing/repository-contract";
export {
	createSnapshotStoreContractTests,
	type SnapshotStoreContractEnvironment,
	type SnapshotStoreContractHarness,
	type SnapshotStoreContractTest,
} from "./testing/snapshot-store-contract";
