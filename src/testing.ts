/**
 * Opt-in testing entry point (`@shirudo/ddd-kit/testing`).
 *
 * Ships the repository contract test suite: the kit is ORM-agnostic,
 * so optimistic concurrency is a repository CONTRACT the consumer's
 * adapter must prove — this entry provides the proof harness. Kept out
 * of the core barrel so test-only code never rides into production
 * bundles.
 */
export * from "./testing/repository-contract";
