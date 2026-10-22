/**
 * The domain state machine: a declared lifecycle with guarded transitions,
 * pure transition functions, and a static analysis of a definition. An
 * optional capability of the kit, published as `@shirudo/ddd-kit/state-machine`.
 * The entry point is experimental: a minor release can change it in a
 * breaking way (see STABILITY.md).
 *
 * @module @shirudo/ddd-kit/state-machine
 */
export {
	analyzeDomainMachineDefinition,
	canTransitionDomainState,
	createInitialDomainMachineSnapshot,
	type DomainMachineDefinition,
	type DomainMachineDefinitionAnalysis,
	type DomainMachineDefinitionDiagnostic,
	type DomainMachineInput,
	type DomainMachineReadonly,
	type DomainMachineSnapshot,
	type DomainMachineTransitionDescription,
	DomainStateMachine,
	type DomainStateNode,
	type DomainTransition,
	DomainTransitionGuardRejectedError,
	type DomainTransitionGuardResult,
	type DomainTransitionOutcome,
	type DomainTransitionResult,
	InvalidDomainTransitionError,
	type PreparedDomainMachineDefinition,
	prepareDomainMachineDefinition,
	transitionDomainState,
} from "./domain-state-machine";
