import type { AnyDomainEvent } from "../aggregate/domain-event";
import type { Outbox, OutboxRecord } from "./ports";

/**
 * In-memory reference implementation of `Outbox<Evt>`.
 *
 * Intended for tests, single-process workers, and quick-start demos.
 * Uses the event's own `eventId` as the dispatch id — the common, clean
 * choice. Storage is a `Map<string, OutboxRecord<Evt>>` keyed by
 * `eventId`, so re-adding the same event is naturally idempotent (the
 * duplicate entry overwrites itself; `getPending` returns each event at
 * most once).
 *
 * For production, back the outbox with a transactional store so the
 * outbox row participates in the same transaction as the aggregate
 * write (see `TransactionScope` + `withCommit`). This class lives in
 * memory only — events are lost on process restart.
 *
 * @example
 * ```ts
 * import { InMemoryOutbox, EventBusImpl, withCommit } from "@shirudo/ddd-kit";
 *
 * const outbox = new InMemoryOutbox<OrderEvent>();
 * const bus = new EventBusImpl<OrderEvent>();
 *
 * await withCommit({ scope, outbox, bus }, async (tx) => {
 *   const orderRepository = makeOrderRepository(tx);
 *   const order = await orderRepository.getByIdOrFail(id);
 *   order.confirm();
 *   await orderRepository.save(order);
 *   return { result: order.id, aggregates: [order] };
 * });
 * ```
 */
export class InMemoryOutbox<Evt extends AnyDomainEvent> implements Outbox<Evt> {
	private readonly pending = new Map<string, OutboxRecord<Evt>>();

	async add(events: ReadonlyArray<Evt>): Promise<void> {
		for (const event of events) {
			this.pending.set(event.eventId, {
				dispatchId: event.eventId,
				event,
			});
		}
	}

	async getPending(
		limit?: number,
	): Promise<ReadonlyArray<OutboxRecord<Evt>>> {
		const all = [...this.pending.values()];
		return typeof limit === "number" ? all.slice(0, limit) : all;
	}

	async markDispatched(dispatchIds: ReadonlyArray<string>): Promise<void> {
		for (const id of dispatchIds) this.pending.delete(id);
	}
}
