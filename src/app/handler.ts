import type { EventBus, Outbox } from "../events/ports";
import type { UnitOfWork } from "../repo/uow";

/**
 * Helper for executing a write Use Case inside a Unit of Work.
 *
 * Order of operations:
 *  1. `fn()` runs inside `uow.transactional(...)` — domain mutations + repo
 *     writes happen here.
 *  2. `outbox.add(events)` is also inside the transaction, so events
 *     persist atomically with the state change (outbox pattern).
 *  3. The transaction commits.
 *  4. **After** the commit, `bus.publish(events)` fires for the in-process
 *     fast path.
 *
 * Publishing AFTER commit prevents the classic "publish before commit"
 * footgun: in-process subscribers can never react to events from a
 * transaction that later rolled back. If `bus.publish` itself fails, the
 * outbox still holds the events and an outbox-dispatcher will deliver them
 * (eventual consistency).
 *
 * @example
 * ```typescript
 * const result = await withCommit(
 *   { outbox, bus, uow },
 *   async () => {
 *     const order = Order.create(customerId, items);
 *     await repository.save(order);
 *     return { result: order.id, events: order.domainEvents };
 *   }
 * );
 * ```
 */
export async function withCommit<Evt extends { type: string }, R>(
	deps: {
		outbox: Outbox<Evt>;
		bus?: EventBus<Evt>;
		uow: UnitOfWork;
	},
	fn: () => Promise<{ result: R; events: ReadonlyArray<Evt> }>,
): Promise<R> {
	const { result, events } = await deps.uow.transactional(async () => {
		const fnResult = await fn();
		await deps.outbox.add(fnResult.events);
		return fnResult;
	});

	if (deps.bus) {
		await deps.bus.publish(events);
	}

	return result;
}
