/**
 * Opt-in testing entry point (`@shirudo/ddd-kit/testing`).
 *
 * Ships the adapter contract test suites (event-sourced repositories, event
 * stores, event and command outboxes, idempotency stores, projections,
 * snapshots, and deadlines):
 * the kit is ORM- and store-agnostic, so optimistic concurrency, outbox
 * semantics, and the idempotency lifecycle are adapter CONTRACTS the
 * consumer's implementation must prove; this entry provides the proof
 * harnesses. Kept out of the core barrel so test-only code never rides
 * into production bundles. Named exports only; a module this file does
 * not export is kit-internal test support.
 */
export {
	type CommandOutboxContractEnvironment,
	type CommandOutboxContractHarness,
	type CommandOutboxContractTest,
	createCommandOutboxContractTests,
} from "./command-outbox-contract";
export {
	createDeadlineStoreContractTests,
	type DeadlineStoreContractEnvironment,
	type DeadlineStoreContractHarness,
	type DeadlineStoreContractTest,
} from "./deadline-store-contract";
export {
	createEsRepositoryContractTests,
	type EsContractRepository,
	type EsRepositoryContractEnvironment,
	type EsRepositoryContractHarness,
	type EsRepositoryContractTest,
} from "./es-repository-contract";
export {
	createEventBusContractTests,
	type EventBusContractEnvironment,
	type EventBusContractHarness,
	type EventBusContractTest,
} from "./event-bus-contract";
export {
	createEventStoreContractTests,
	type EventStoreContractEnvironment,
	type EventStoreContractHarness,
	type EventStoreContractTest,
} from "./event-store-contract";
export {
	createIdempotencyStoreContractTests,
	type IdempotencyStoreContractEnvironment,
	type IdempotencyStoreContractHarness,
	type IdempotencyStoreContractTest,
} from "./idempotency-store-contract";
export {
	createOutboxContractTests,
	type OutboxContractEnvironment,
	type OutboxContractHarness,
	type OutboxContractTest,
} from "./outbox-contract";
export {
	createProjectionCheckpointStoreContractTests,
	type ProjectionCheckpointStoreContractEnvironment,
	type ProjectionCheckpointStoreContractHarness,
	type ProjectionCheckpointStoreContractTest,
} from "./projection-checkpoint-contract";
export {
	type ContractRepository,
	createRepositoryContractTests,
	type RepositoryContractEnvironment,
	type RepositoryContractHarness,
	type RepositoryContractTest,
} from "./repository-contract";
export {
	createSnapshotStoreContractTests,
	type SnapshotStoreContractEnvironment,
	type SnapshotStoreContractHarness,
	type SnapshotStoreContractTest,
} from "./snapshot-store-contract";
