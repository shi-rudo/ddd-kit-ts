import type { EventBus, Outbox } from "../events/ports";
import type { UnitOfWork } from "../repo/uow";

/**
 * Helper function for executing commands within a transaction.
 * Handles event persistence via outbox and optional event bus publishing.
 *
 * @param deps - Dependencies including outbox, optional event bus, and unit of work
 * @param fn - Function that returns result and events
 * @returns The result wrapped in a transaction
 *
 * @example
 * ```typescript
 * const result = await withCommit(
 *   { outbox, bus, uow },
 *   async () => {
 *     const order = Order.create(customerId, items);
 *     await repository.save(order);
 *     return {
 *       result: order.id,
 *       events: order.pendingEvents
 *     };
 *   }
 * );
 * ```
 */
export function withCommit<Evt, R>(
	deps: {
		outbox: Outbox<Evt>;
		bus?: EventBus<Evt>;
		uow: UnitOfWork;
	},
	fn: () => Promise<{ result: R; events: ReadonlyArray<Evt> }>,
) {
	return deps.uow.transactional(async () => {
		const { result, events } = await fn();
		await deps.outbox.add(events);
		if (deps.bus) await deps.bus.publish(events);
		return result;
	});
}
