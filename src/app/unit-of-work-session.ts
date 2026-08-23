import type { IAggregateRoot, Version } from "../aggregate/aggregate";
import type {
	AnyDomainEvent,
	PendingDomainEvent,
} from "../aggregate/domain-event";
import {
	AggregateDeletedError,
	type InfrastructureError,
	isInfrastructureErrorLike,
	UnenrolledChangesError,
} from "../core/errors";
import type { Id } from "../core/id";
import { IdentityMap } from "../repo/identity-map";
import {
	capturePersistenceBaseline,
	derivePersistenceChanges,
	insertPersistenceBaseline,
	type PersistenceBaseline,
	type PersistenceChanges,
	persistenceProjectionDrifted,
	recapturePersistenceBaseline,
} from "../repo/persistence-model";
import {
	AggregateTrackingError,
	RepositoryErrorMappingFailedError,
	TransactionClosedError,
} from "./errors";
import type { AggregateCommitToken, CommitEnrollment } from "./handler";
import type {
	AggregatePersistenceWrite,
	AggregateWriteIntent,
	RepositoryTracking,
	RuntimePersistenceDefinition,
	UnitOfWorkIdentityMap,
} from "./persistence-contract";

type AggregateLifecycle = "new" | "loaded";

/**
 * The immutable receipt one add/update/remove registration freezes: intent,
 * exact version and event batch, the sealed persistence baseline, and the
 * derived change set. It exists as ONE optional unit so registration,
 * rollback, and flush cannot half-apply it; `registration === undefined`
 * means "tracked but no write registered".
 */
interface WriteRegistration<Evt extends AnyDomainEvent> {
	readonly intent: AggregateWriteIntent;
	readonly version: Version;
	readonly events: ReadonlyArray<PendingDomainEvent<Evt>>;
	readonly baseline: PersistenceBaseline<
		IAggregateRoot<Id<string>, Evt>,
		unknown
	>;
	readonly changes: PersistenceChanges<unknown>;
}

interface TrackedAggregate<Evt extends AnyDomainEvent> {
	readonly aggregate: IAggregateRoot<Id<string>, Evt>;
	readonly lifecycle: AggregateLifecycle;
	readonly expectedVersion: Version | undefined;
	readonly definition: RuntimePersistenceDefinition<Evt>;
	readonly baseline: PersistenceBaseline<
		IAggregateRoot<Id<string>, Evt>,
		unknown
	>;
	registration?: WriteRegistration<Evt>;
}

/**
 * Tracks the aggregates of one `run()`: identity map, write intent and
 * commit registration. Closed by `run()`'s finally.
 *
 * @internal Shared with the unit of work in this package; not part of
 * the public API.
 */
export class Session<Evt extends AnyDomainEvent> {
	// Read tracking order is independent of write registration order. Flush
	// follows this list so adapters observe the same explicit order as the use
	// case's add/update/remove calls. Enrollment and removal state are NOT
	// separate collections: both derive from each entry's registration, so
	// the bookkeeping cannot drift apart.
	private readonly _registeredWrites: TrackedAggregate<Evt>[] = [];
	private readonly _commitTokens = new Set<AggregateCommitToken<Evt>>();
	private readonly _identityMap = new IdentityMap();
	// What adapters receive: the typed read-only view, enforced at runtime.
	// Handing out the map itself would expose set/delete/clear to JavaScript
	// callers, and a stray clear() erases deletion tombstones and the
	// pending-event baselines behind UnenrolledChangesError.
	private readonly _identityMapView = Object.freeze({
		get: this._identityMap.get.bind(this._identityMap),
		has: this._identityMap.has.bind(this._identityMap),
		isDeleted: this._identityMap.isDeleted.bind(this._identityMap),
	}) as UnitOfWorkIdentityMap;
	private readonly _trackingByAggregate = new WeakMap<
		IAggregateRoot<Id<string>, Evt>,
		TrackedAggregate<Evt>
	>();
	private readonly _trackedAggregates = new Set<TrackedAggregate<Evt>>();
	private _closed = false;

	constructor(private readonly commitEnrollment: CommitEnrollment<Evt>) {}

	public get identityMap(): UnitOfWorkIdentityMap {
		this.assertOpen("tracking.identityMap");
		return this._identityMapView;
	}

	public trackingFor(
		definition: RuntimePersistenceDefinition<Evt>,
	): RepositoryTracking<IAggregateRoot<Id<string>, Evt>> {
		const session = this;
		return Object.freeze({
			get identityMap() {
				return session.identityMap;
			},
			trackLoaded: (aggregate: IAggregateRoot<Id<string>, Evt>) =>
				session.trackLoaded(aggregate, definition),
		});
	}

	/** The registration of an instance, or undefined when none is tracked. */
	private registrationOf(
		aggregate: object,
	): WriteRegistration<Evt> | undefined {
		return this._trackingByAggregate.get(
			aggregate as IAggregateRoot<Id<string>, Evt>,
		)?.registration;
	}

	/** Whether THIS instance registered a remove in this session. */
	private isRemovedInstance(aggregate: object): boolean {
		return this.registrationOf(aggregate)?.intent === "remove";
	}

	private trackLoaded<TAggregate extends IAggregateRoot<Id<string>, Evt>>(
		aggregate: TAggregate,
		definition: RuntimePersistenceDefinition<Evt>,
	): TAggregate {
		this.assertOpen("tracking.trackLoaded");
		// Ownership is checked BEFORE identity-map registration: a rejected
		// instance must not stay registered under the second definition's
		// class key with no tracking entry behind it.
		const existing = this._trackingByAggregate.get(aggregate);
		if (existing && existing.definition !== definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				"load",
				"different_repository",
				existing.registration?.intent,
			);
		}
		this._identityMap.set(definition.aggregate, aggregate.id, aggregate);
		if (existing) return aggregate;

		const entry: TrackedAggregate<Evt> = {
			aggregate,
			lifecycle: "loaded",
			expectedVersion: aggregate.version,
			definition,
			baseline: capturePersistenceBaseline(definition.persistence, aggregate),
		};
		this._trackingByAggregate.set(aggregate, entry);
		this._trackedAggregates.add(entry);
		return aggregate;
	}

	public add(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		this.assertOpen("repository.add");
		this.assertNotRemoved(aggregate, definition);
		const existing = this._trackingByAggregate.get(aggregate);
		if (existing && existing.definition !== definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				"add",
				"different_repository",
				existing.registration?.intent,
			);
		}
		if (existing?.lifecycle === "loaded") {
			throw new AggregateTrackingError(
				String(aggregate.id),
				"add",
				"loaded_as_new",
				existing.registration?.intent,
			);
		}

		let entry = existing;
		const newlyTracked = !entry;
		if (!entry) {
			this._identityMap.set(definition.aggregate, aggregate.id, aggregate);
			entry = {
				aggregate,
				lifecycle: "new",
				expectedVersion: undefined,
				definition,
				baseline: insertPersistenceBaseline(definition.persistence),
			};
			this._trackingByAggregate.set(aggregate, entry);
			this._trackedAggregates.add(entry);
		}

		try {
			this.registerWrite(entry, "add", definition);
		} catch (error) {
			// A failed add must not leave a phantom: without this rollback,
			// findById would serve the never-persisted instance from the
			// identity map while the commit-readiness guard ignores "new"
			// lifecycle entries, so the transaction would commit without a
			// write for it.
			if (newlyTracked) {
				this._trackingByAggregate.delete(aggregate);
				this._trackedAggregates.delete(entry);
				this._identityMap.discard(
					definition.aggregate,
					aggregate.id,
					aggregate,
				);
			}
			throw error;
		}
	}

	public update(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		this.assertOpen("repository.update");
		const entry = this.loadedEntryFor(aggregate, "update", definition);
		this.registerWrite(entry, "update", definition);
	}

	public remove(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		this.assertOpen("repository.remove");
		// Idempotent by reference, like add and update: a repeated remove of
		// the SAME instance re-declares the same final lifecycle outcome
		// (collection semantics; the enrollment layer already returns the
		// same token for a repeat enrollDeleted). The deletion-finality gate
		// stays sharp for everything else: add, update, and trackLoaded
		// after remove, and any OTHER instance with the same id, still
		// reject.
		const entry = this._trackingByAggregate.get(aggregate);
		if (this.isRemovedInstance(aggregate) && entry?.definition === definition) {
			return;
		}
		const loaded = this.loadedEntryFor(aggregate, "remove", definition);
		this.registerWrite(loaded, "remove", definition);
	}

	/** Registers persistence intent and commit enrollment as one operation. */
	private registerWrite(
		entry: TrackedAggregate<Evt>,
		intent: AggregateWriteIntent,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		const newlyRegistered = this.registerIntent(entry, intent);
		try {
			if (intent === "remove") {
				this.registerRemovedCommit(
					entry.aggregate,
					definition,
					entry.expectedVersion,
				);
			} else {
				this.registerSavedCommit(
					entry.aggregate,
					definition,
					entry.expectedVersion,
				);
			}
		} catch (error) {
			if (newlyRegistered) this.rollbackIntentRegistration(entry);
			throw error;
		}
	}

	private loadedEntryFor(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		operation: "update" | "remove",
		definition: RuntimePersistenceDefinition<Evt>,
	): TrackedAggregate<Evt> {
		this.assertNotRemoved(aggregate, definition);
		const entry = this._trackingByAggregate.get(aggregate);
		// Repository-ownership violations report as such on every operation:
		// add and trackLoaded already use different_repository, and code
		// branching on the machine-readable reason must not get not_loaded
		// for the identical violation on the update/remove path.
		if (entry && entry.definition !== definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				operation,
				"different_repository",
				entry.registration?.intent,
			);
		}
		// An add()-registered aggregate IS tracked, just not "loaded": report
		// the real conflict with the registered intent. The not_loaded advice
		// ("load it through the repository") is impossible for an aggregate
		// that has no row yet and would actively mislead.
		if (entry && entry.lifecycle === "new" && entry.definition === definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				operation,
				"conflicting_intent",
				entry.registration?.intent,
			);
		}
		if (entry?.lifecycle !== "loaded" || entry.definition !== definition) {
			throw new AggregateTrackingError(
				String(aggregate.id),
				operation,
				"not_loaded",
				entry?.registration?.intent,
			);
		}
		return entry;
	}

	private assertNotRemoved(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
	): void {
		if (this._identityMap.isDeleted(definition.aggregate, aggregate.id)) {
			throw new AggregateDeletedError(String(aggregate.id));
		}
	}

	private registerIntent(
		entry: TrackedAggregate<Evt>,
		intent: AggregateWriteIntent,
	): boolean {
		if (entry.registration !== undefined) {
			if (entry.registration.intent !== intent) {
				throw new AggregateTrackingError(
					String(entry.aggregate.id),
					intent,
					"conflicting_intent",
					entry.registration.intent,
				);
			}
			this.assertUnchangedAfterRegistration(entry);
			return false;
		}

		entry.registration = Object.freeze({
			intent,
			version: entry.aggregate.version,
			// Already a frozen detached copy from the pendingEvents getter.
			events: entry.aggregate.pendingEvents,
			baseline: recapturePersistenceBaseline(entry.baseline, entry.aggregate),
			changes: derivePersistenceChanges(entry.baseline, entry.aggregate),
		});
		this._registeredWrites.push(entry);
		return true;
	}

	/** Restores the pre-registration state when commit enrollment rejects. */
	private rollbackIntentRegistration(entry: TrackedAggregate<Evt>): void {
		const index = this._registeredWrites.lastIndexOf(entry);
		if (index >= 0) this._registeredWrites.splice(index, 1);
		delete entry.registration;
	}

	private assertUnchangedAfterRegistration(entry: TrackedAggregate<Evt>): void {
		const registration = entry.registration;
		if (registration === undefined) return;
		const currentEvents = entry.aggregate.pendingEvents;
		// Capture-to-capture drift, NOT changes().isEmpty(): the
		// PersistenceModel contract permits full-replacement change sets that
		// are never empty, so a non-empty change set proves nothing about
		// mutation after registration.
		const persistenceChanged = persistenceProjectionDrifted(
			registration.baseline,
			entry.aggregate,
		);
		const sameEvents =
			currentEvents.length === registration.events.length &&
			currentEvents.every(
				(event, index) => event === registration.events[index],
			);
		if (
			registration.version !== entry.aggregate.version ||
			!sameEvents ||
			persistenceChanged
		) {
			throw new AggregateTrackingError(
				String(entry.aggregate.id),
				"commit",
				"mutated_after_registration",
				registration.intent,
			);
		}
	}

	private registerSavedCommit(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
		expectedVersion: Version | undefined,
	): AggregateCommitToken<Evt> {
		this.assertOpen("repository.add/update");
		// Two gates, one invariant: the registration check catches the same
		// reference; the identity-map tombstone (keyed on the instance's
		// concrete class) catches a DIFFERENT instance with the same
		// type+id: e.g. one re-created via the static factory after the
		// delete. Both mean "deleted is final within this operation".
		if (
			this.isRemovedInstance(aggregate) ||
			this._identityMap.isDeleted(definition.aggregate, aggregate.id)
		) {
			throw new AggregateDeletedError(String(aggregate.id));
		}
		const token = this.commitEnrollment.enrollSaved(aggregate, {
			expectedVersion,
		});
		this._commitTokens.add(token);
		return token;
	}

	private registerRemovedCommit(
		aggregate: IAggregateRoot<Id<string>, Evt>,
		definition: RuntimePersistenceDefinition<Evt>,
		expectedVersion: Version | undefined,
	): AggregateCommitToken<Evt> {
		this.assertOpen("repository.remove");
		const token = this.commitEnrollment.enrollDeleted(aggregate, {
			expectedVersion,
		});
		// One call does ALL the deletion bookkeeping: the identity-map
		// entry is removed and tombstoned automatically (keyed on the
		// instance's concrete class), so repositories do not need a
		// second manual identityMap.delete() call; a forgotten leg of a
		// two-call protocol would silently weaken the deletion gate. The
		// removed state itself derives from the entry's registration.
		// Assumption (documented on IdentityMap): repositories key the
		// map with the same concrete class their factories produce.
		// Deleted aggregates stay in the harvest set: their recorded
		// deletion events must reach the outbox (repository.md, hard-
		// delete with event harvest). withCommit receives them in the
		// deleted token disposition, so the saved-only application observer
		// never fires for a deletion.
		this._identityMap.delete(definition.aggregate, aggregate.id);
		this._commitTokens.add(token);
		return token;
	}

	/**
	 * End-of-run safety net. A loaded aggregate whose version or pending event
	 * batch changed without `update` intent would otherwise be silently lost.
	 * An aggregate that changed after registration could persist state and
	 * events from different moments. Both violations reject inside the
	 * transaction.
	 */
	public assertReadyToCommit(): void {
		for (const entry of this._trackedAggregates) {
			if (entry.registration !== undefined) {
				this.assertUnchangedAfterRegistration(entry);
				continue;
			}
			// Capture-to-capture drift against the load-time baseline: a
			// full-replacement model's changes() is never empty, which would
			// misreport every merely-loaded aggregate as unenrolled changes.
			if (
				entry.lifecycle === "loaded" &&
				(entry.aggregate.version !== entry.expectedVersion ||
					persistenceProjectionDrifted(entry.baseline, entry.aggregate))
			) {
				throw new UnenrolledChangesError(String(entry.aggregate.id));
			}
		}

		for (const instance of this._identityMap.instancesWithNewPendingEvents()) {
			// Any registration (add, update, or remove) means the instance is
			// enrolled and its batch will be harvested.
			if (
				instance !== null &&
				typeof instance === "object" &&
				this.registrationOf(instance) !== undefined
			) {
				continue;
			}
			// Events were recorded on a loaded aggregate after it was
			// registered, yet it has no write intent: a forgotten update whose
			// events would be silently dropped.
			const id = (instance as { id?: unknown }).id;
			throw new UnenrolledChangesError(String(id));
		}
	}

	/** Flushes every registered receipt in deterministic registration order. */
	public async flush(transaction: unknown): Promise<void> {
		this.assertOpen("unitOfWork.flush");
		for (const entry of this._registeredWrites) {
			const registration = entry.registration;
			if (registration === undefined) {
				throw new AggregateTrackingError(
					String(entry.aggregate.id),
					"commit",
					"mutated_after_registration",
				);
			}
			const write = Object.freeze({
				intent: registration.intent,
				aggregateId: entry.aggregate.id,
				expectedVersion: entry.expectedVersion,
				version: registration.version,
				changes: registration.changes,
				events: registration.events,
			}) as AggregatePersistenceWrite<IAggregateRoot<Id<string>, Evt>, unknown>;
			try {
				await entry.definition.flush(transaction, write);
			} catch (error) {
				throw mapRepositoryPersistenceError(entry.definition, error, write);
			}
		}
	}

	public get commitTokens(): ReadonlyArray<AggregateCommitToken<Evt>> {
		return [...this._commitTokens];
	}

	public close(): void {
		this._closed = true;
		// Defensive: a leaked direct IdentityMap reference must not serve
		// stale instances into a later operation (that would silently
		// bypass OCC). The session getter already throws after close;
		// clearing covers refs captured before.
		this._identityMap.clear();
		this._trackedAggregates.clear();
		this._registeredWrites.length = 0;
		this._commitTokens.clear();
	}

	public assertOpen(operation: string): void {
		if (this._closed) {
			throw new TransactionClosedError(operation);
		}
	}
}
function mapRepositoryPersistenceError<Evt extends AnyDomainEvent>(
	definition: RuntimePersistenceDefinition<Evt>,
	error: unknown,
	write: AggregatePersistenceWrite<IAggregateRoot<Id<string>, Evt>, unknown>,
): InfrastructureError {
	let mapped: unknown;
	try {
		mapped = definition.mapError(error, write);
	} catch (mapperError) {
		throw new RepositoryErrorMappingFailedError({
			aggregateId: String(write.aggregateId),
			intent: write.intent,
			persistenceError: error,
			mapperError,
		});
	}
	// Copy-safe: an adapter package can carry its own copy of the kit, whose
	// InfrastructureError fails a plain instanceof here; rejecting it would
	// turn every retryable conflict into a non-retryable wiring crash that
	// blames a correct mapper.
	if (isInfrastructureErrorLike(mapped)) return mapped;
	throw new RepositoryErrorMappingFailedError({
		aggregateId: String(write.aggregateId),
		intent: write.intent,
		persistenceError: error,
		mapperError: new TypeError(
			"Repository mapError must return an InfrastructureError instance",
		),
	});
}
