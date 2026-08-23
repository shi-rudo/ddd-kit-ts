import type { IAggregateRoot } from "../aggregate/aggregate";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { Id } from "../core/id";
import { InvalidRepositoryAdapterError } from "./errors";
import type { RuntimePersistenceDefinition } from "./persistence-contract";

/**
 * The part of the running unit of work that a facade needs: the open
 * check, and the three lifecycle writes it installs on the facade. The
 * facade never reaches further into the session, and stating that here
 * keeps the dependency pointing one way.
 */
interface RepositoryFacadeSession<Evt extends AnyDomainEvent> {
	assertOpen(operation: string): void;
	add(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void;
	update(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void;
	remove(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void;
}

/**
 * Builds the application-facing repository facade. Standard lifecycle writes
 * are always supplied by the Unit of Work; similarly named adapter methods are
 * never invoked. Other methods are bound to the adapter so classes with private
 * fields keep their normal receiver.
 */
export function bindRepositoryWrites<TRepository, Evt extends AnyDomainEvent>(
	adapter: TRepository,
	session: RepositoryFacadeSession<Evt>,
	definition: RuntimePersistenceDefinition<Evt>,
	repository: string,
): TRepository {
	if (adapter === null || typeof adapter !== "object") {
		throw new InvalidRepositoryAdapterError(
			repository,
			adapter === null ? "null" : typeof adapter,
		);
	}

	const state = createRepositoryFacadeState(
		adapter as object,
		session,
		definition,
	);
	installRepositoryLifecycleOperations(state);
	forwardAdapterOwnProperties(state);
	return new Proxy(
		state.target,
		createRepositoryFacadeHandler(state),
	) as TRepository;
}

const REPOSITORY_LIFECYCLE_OPERATIONS = ["add", "update", "remove"] as const;

interface GuardedMethodCacheEntry {
	/** The source function the wrapper was built over; identity-checked on
	 * every read so a self-mutated adapter method cannot serve stale. */
	readonly sourceMethod: (...args: unknown[]) => unknown;
	readonly guarded: (...args: unknown[]) => unknown;
}

interface RepositoryFacadeState<Evt extends AnyDomainEvent> {
	readonly source: object;
	readonly target: object;
	readonly session: RepositoryFacadeSession<Evt>;
	readonly definition: RuntimePersistenceDefinition<Evt>;
	readonly methodCache: Map<PropertyKey, GuardedMethodCacheEntry>;
	readonly forwardedOwnProperties: Set<PropertyKey>;
	readonly writes: Set<PropertyKey>;
}

function createRepositoryFacadeState<Evt extends AnyDomainEvent>(
	source: object,
	session: RepositoryFacadeSession<Evt>,
	definition: RuntimePersistenceDefinition<Evt>,
): RepositoryFacadeState<Evt> {
	return {
		source,
		target: Object.create(Reflect.getPrototypeOf(source)) as object,
		session,
		definition,
		methodCache: new Map(),
		forwardedOwnProperties: new Set(),
		writes: new Set(),
	};
}

function repositoryOperationName(property: PropertyKey): string {
	const name =
		typeof property === "symbol"
			? (property.description ?? property.toString())
			: property;
	return `repository.${name}`;
}

function isRepositoryLifecycleOperation(property: PropertyKey): boolean {
	return REPOSITORY_LIFECYCLE_OPERATIONS.includes(
		property as (typeof REPOSITORY_LIFECYCLE_OPERATIONS)[number],
	);
}

/**
 * Own-or-inherited presence that stops BEFORE `Object.prototype`: members
 * every object inherits (`toString`, `valueOf`, `constructor`) are language
 * plumbing, not repository surface, and must not trip the facade's
 * session-open assertion.
 */
function hasMemberBelowObjectPrototype(
	object: object,
	property: PropertyKey,
): boolean {
	let current: object | null = object;
	while (current !== null && current !== Object.prototype) {
		if (Reflect.getOwnPropertyDescriptor(current, property)) return true;
		current = Reflect.getPrototypeOf(current);
	}
	return false;
}

function readRepositorySource<Evt extends AnyDomainEvent>(
	state: RepositoryFacadeState<Evt>,
	property: PropertyKey,
): unknown {
	state.session.assertOpen(repositoryOperationName(property));
	const value = Reflect.get(state.source, property, state.source);
	if (typeof value !== "function") return value;
	// Cache validity is keyed on the CURRENT source function, not the
	// property name alone: adapter methods run with `this` bound to the raw
	// source, so a lazy-init self-assignment replaces the method without any
	// proxy trap firing. A name-only cache would keep serving the wrapper
	// closed over the replaced function for the rest of the run.
	const cached = state.methodCache.get(property);
	if (cached && cached.sourceMethod === value) return cached.guarded;
	const sourceMethod = value as (...args: unknown[]) => unknown;
	const guarded = (...args: unknown[]): unknown => {
		state.session.assertOpen(repositoryOperationName(property));
		return Reflect.apply(sourceMethod, state.source, args);
	};
	state.methodCache.set(property, { sourceMethod, guarded });
	return guarded;
}

function defineForwardedRepositoryProperty<Evt extends AnyDomainEvent>(
	state: RepositoryFacadeState<Evt>,
	property: PropertyKey,
	descriptor: PropertyDescriptor,
): void {
	Object.defineProperty(state.target, property, {
		configurable: true,
		enumerable: descriptor.enumerable ?? false,
		get: () => readRepositorySource(state, property),
		set:
			("value" in descriptor && descriptor.writable) || descriptor.set
				? (value: unknown) => {
						state.session.assertOpen(repositoryOperationName(property));
						if (!Reflect.set(state.source, property, value, state.source)) {
							throw new TypeError(
								`Cannot assign to repository property ${String(property)}`,
							);
						}
					}
				: undefined,
	});
	state.forwardedOwnProperties.add(property);
}

function installRepositoryLifecycleOperations<Evt extends AnyDomainEvent>(
	state: RepositoryFacadeState<Evt>,
): void {
	const operations = state.definition.physicalRemoval
		? REPOSITORY_LIFECYCLE_OPERATIONS
		: REPOSITORY_LIFECYCLE_OPERATIONS.slice(0, 2);
	for (const operation of operations) {
		state.writes.add(operation);
		Object.defineProperty(state.target, operation, {
			configurable: false,
			enumerable: false,
			writable: false,
			value: (aggregate: unknown) => {
				state.session.assertOpen(repositoryOperationName(operation));
				state.session[operation](
					aggregate as IAggregateRoot<Id<string>, Evt>,
					state.definition,
				);
			},
		});
	}
}

function forwardAdapterOwnProperties<Evt extends AnyDomainEvent>(
	state: RepositoryFacadeState<Evt>,
): void {
	for (const property of Reflect.ownKeys(state.source)) {
		if (isRepositoryLifecycleOperation(property)) continue;
		const descriptor = Reflect.getOwnPropertyDescriptor(state.source, property);
		if (descriptor) {
			defineForwardedRepositoryProperty(state, property, descriptor);
		}
	}
}

function createRepositoryFacadeHandler<Evt extends AnyDomainEvent>(
	state: RepositoryFacadeState<Evt>,
): ProxyHandler<object> {
	return {
		get: (target, property, receiver) => {
			// Language-level probes are not repository operations: promise
			// resolution reads `then` on any value returned from run(),
			// JSON.stringify probes `toJSON`, string interpolation reads
			// `toString`, and inspection utilities read well-known symbols.
			// One principled rule instead of one exemption per discovered
			// probe: only a property present BELOW Object.prototype is
			// repository surface and gets the session-open assertion.
			// Everything else is language plumbing and answers normally, so
			// logging a leaked facade after close cannot mask the original
			// failure. Member reads keep the loud TransactionClosedError
			// (a probe cannot leak state; a member read can).
			if (
				!hasMemberBelowObjectPrototype(target, property) &&
				!hasMemberBelowObjectPrototype(state.source, property)
			) {
				return Reflect.get(target, property, receiver);
			}
			state.session.assertOpen(repositoryOperationName(property));
			const own = Reflect.getOwnPropertyDescriptor(target, property);
			if (own) return Reflect.get(target, property, receiver);
			if (property === "remove") return undefined;
			return readRepositorySource(state, property);
		},
		set: (target, property, value, receiver) =>
			setRepositoryFacadeProperty(state, target, property, value, receiver),
		has: (target, property) => {
			state.session.assertOpen(repositoryOperationName(property));
			return (
				state.writes.has(property) ||
				(property !== "remove" &&
					(Reflect.has(target, property) ||
						Reflect.has(state.source, property)))
			);
		},
		defineProperty: (target, property, descriptor) =>
			defineRepositoryFacadeProperty(state, target, property, descriptor),
		deleteProperty: (target, property) =>
			deleteRepositoryFacadeProperty(state, target, property),
	};
}

function setRepositoryFacadeProperty<Evt extends AnyDomainEvent>(
	state: RepositoryFacadeState<Evt>,
	target: object,
	property: PropertyKey,
	value: unknown,
	receiver: unknown,
): boolean {
	state.session.assertOpen(repositoryOperationName(property));
	if (isRepositoryLifecycleOperation(property)) return false;
	if (Reflect.getOwnPropertyDescriptor(target, property)) {
		const set = Reflect.set(target, property, value, receiver);
		if (set) state.methodCache.delete(property);
		return set;
	}
	if (!Reflect.isExtensible(target)) return false;
	const set = Reflect.set(state.source, property, value, state.source);
	const descriptor = Reflect.getOwnPropertyDescriptor(state.source, property);
	if (set && descriptor) {
		defineForwardedRepositoryProperty(state, property, descriptor);
	}
	// Every successful set invalidates the guarded-method cache, matching the
	// own-descriptor and delete paths: a cached wrapper closed over the
	// replaced function must not outlive the override (test spies, strategy
	// swaps).
	if (set) state.methodCache.delete(property);
	return set;
}

function defineRepositoryFacadeProperty<Evt extends AnyDomainEvent>(
	state: RepositoryFacadeState<Evt>,
	target: object,
	property: PropertyKey,
	descriptor: PropertyDescriptor,
): boolean {
	state.session.assertOpen(repositoryOperationName(property));
	if (
		isRepositoryLifecycleOperation(property) &&
		!Reflect.getOwnPropertyDescriptor(target, property)
	) {
		return false;
	}
	const current = Reflect.getOwnPropertyDescriptor(target, property);
	if (!Reflect.defineProperty(target, property, descriptor)) return false;
	const next = Reflect.getOwnPropertyDescriptor(target, property);
	if (
		state.forwardedOwnProperties.has(property) &&
		(current?.get !== next?.get || current?.set !== next?.set)
	) {
		state.forwardedOwnProperties.delete(property);
	}
	return true;
}

function deleteRepositoryFacadeProperty<Evt extends AnyDomainEvent>(
	state: RepositoryFacadeState<Evt>,
	target: object,
	property: PropertyKey,
): boolean {
	state.session.assertOpen(repositoryOperationName(property));
	if (isRepositoryLifecycleOperation(property)) return false;
	const targetDescriptor = Reflect.getOwnPropertyDescriptor(target, property);
	if (targetDescriptor && !state.forwardedOwnProperties.has(property)) {
		return Reflect.deleteProperty(target, property);
	}
	const sourceDescriptor = Reflect.getOwnPropertyDescriptor(
		state.source,
		property,
	);
	if (
		targetDescriptor?.configurable === false ||
		sourceDescriptor?.configurable === false
	) {
		return false;
	}
	if (!Reflect.deleteProperty(state.source, property)) return false;
	if (targetDescriptor && !Reflect.deleteProperty(target, property))
		return false;
	state.forwardedOwnProperties.delete(property);
	state.methodCache.delete(property);
	return true;
}
