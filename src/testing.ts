/**
 * Opt-in testing entry point (`@shirudo/ddd-kit/testing`).
 *
 * Ships the repository contract test suites (state-stored and
 * event-sourced): the kit is ORM- and store-agnostic, so optimistic
 * concurrency is a repository CONTRACT the consumer's adapter must
 * prove; this entry provides the proof harnesses. Kept out of the core
 * barrel so test-only code never rides into production bundles. Named
 * exports only; the shared suite plumbing in contract-assertions stays
 * internal.
 */
export {
	createEsRepositoryContractTests,
	type EsContractRepository,
	type EsRepositoryContractEnvironment,
	type EsRepositoryContractHarness,
	type EsRepositoryContractTest,
} from "./testing/es-repository-contract";
export {
	type ContractRepository,
	createRepositoryContractTests,
	type RepositoryContractEnvironment,
	type RepositoryContractHarness,
	type RepositoryContractTest,
} from "./testing/repository-contract";
