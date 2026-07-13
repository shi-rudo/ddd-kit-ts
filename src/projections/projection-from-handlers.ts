import type { AnyDomainEvent } from "../aggregate/domain-event";
import { MissingHandlerError } from "../core/errors";
import type { Projection } from "./ports";

/**
 * Explicit no-op entry for {@link ProjectionHandlers}. The projector still
 * consumes and checkpoints the event; only the read-model write is skipped.
 */
export const ignoreProjectionEvent = Symbol("ignoreProjectionEvent");

/** One discriminator-narrowed projection handler. */
export type ProjectionEventHandler<Evt extends AnyDomainEvent, TCtx> = (
	ctx: TCtx,
	event: Evt,
) => Promise<void>;

/**
 * Exhaustive handler map for a declared event union. Every discriminator needs
 * either a narrowed handler or {@link ignoreProjectionEvent}; adding an event
 * to `Evt` therefore creates a compile error until the projection decides how
 * to handle it.
 */
export type ProjectionHandlers<Evt extends AnyDomainEvent, TCtx> = {
	readonly [K in Evt["type"]]:
		| ProjectionEventHandler<Extract<Evt, { type: K }>, TCtx>
		| typeof ignoreProjectionEvent;
};

type RuntimeProjectionHandlerEntry<TCtx, Evt extends AnyDomainEvent> =
	| ProjectionEventHandler<Evt, TCtx>
	| typeof ignoreProjectionEvent;

/** Construction options for {@link projectionFromHandlers}. */
export interface ProjectionFromHandlersOptions<
	Evt extends AnyDomainEvent,
	TCtx,
> {
	/** Stable projection name used by its checkpoints. */
	readonly name: string;
	/** One handler or explicit ignore token for every event in `Evt`. */
	readonly handlers: ProjectionHandlers<Evt, TCtx>;
	/** Optional read-model reset passed through to {@link Projection.truncate}. */
	readonly truncate?: (ctx: TCtx) => Promise<void>;
}

/**
 * Builds a {@link Projection} from an exhaustive, discriminator-narrowed
 * handler map. This is the correctness-oriented alternative to a free-form
 * `Projection.apply`: extending `Evt` forces every projection using that union
 * to add a handler or an explicit {@link ignoreProjectionEvent} entry.
 *
 * The compile-time proof is only as complete as the supplied `Evt` union.
 * At runtime, an undeclared type (including object-prototype names such as
 * `constructor`) throws {@link MissingHandlerError}; the projector rejects the
 * batch without advancing its checkpoint.
 *
 * @example
 * ```ts
 * const projection = projectionFromHandlers<OrderEvent, DbTx>({
 *   name: "order-list",
 *   handlers: {
 *     OrderPlaced: async (tx, event) => {
 *       await tx.orders.insert({ id: event.aggregateId });
 *     },
 *     OrderShipped: ignoreProjectionEvent,
 *   },
 * });
 * ```
 */
export function projectionFromHandlers<Evt extends AnyDomainEvent, TCtx>(
	options: ProjectionFromHandlersOptions<Evt, TCtx>,
): Projection<Evt, TCtx> {
	return {
		name: options.name,
		truncate: options.truncate,
		apply: async (ctx, event) => {
			const entry = Object.hasOwn(options.handlers, event.type)
				? (options.handlers[event.type as Evt["type"]] as
						| RuntimeProjectionHandlerEntry<TCtx, Evt>
						| undefined)
				: undefined;
			if (entry === undefined) {
				throw new MissingHandlerError(event.type);
			}
			if (entry === ignoreProjectionEvent) return;
			await entry(ctx, event);
		},
	};
}
