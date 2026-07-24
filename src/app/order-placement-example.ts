import { err, ok } from "@shirudo/result";
import { AggregateRoot } from "../aggregate/aggregate-root";
import type { AnyDomainEvent } from "../aggregate/domain-event";
import { DomainError } from "../core/errors";
import type { Id } from "../core/id";
import type { Money } from "../money";
import type { Command, CommandHandler } from "./command";
import { domainErrorToResult } from "./domain-error-result";
import type {
	IdempotentCommitRequest,
	WithIdempotentCommitDeps,
} from "./idempotency";
import { withIdempotentCommit } from "./idempotency";

// #region order-domain
export type OrderId = Id<"OrderId">;
export type CustomerId = Id<"CustomerId">;
export type ProductId = Id<"ProductId">;
export type OrderQuantity = number & {
	readonly __brand: "OrderQuantity";
};

export interface PlaceOrderItem {
	readonly productId: ProductId;
	readonly quantity: OrderQuantity;
	readonly price: Money;
}

type OrderState = {
	readonly customerId: CustomerId;
	readonly items: ReadonlyArray<PlaceOrderItem>;
	readonly status: "placed";
};

export class EmptyOrderError extends DomainError<"EMPTY_ORDER"> {
	constructor() {
		super({
			code: "EMPTY_ORDER",
			message: "A placed order requires at least one item",
		});
	}
}

export class Order extends AggregateRoot<OrderState, OrderId> {
	protected readonly aggregateType = "Order";

	static place(
		id: OrderId,
		customerId: CustomerId,
		items: ReadonlyArray<PlaceOrderItem>,
	): Order {
		if (items.length === 0) {
			throw new EmptyOrderError();
		}

		return new Order(id, {
			customerId,
			items: [...items],
			status: "placed",
		});
	}

	get customerId(): CustomerId {
		return this.state.customerId;
	}

	get itemCount(): number {
		return this.state.items.length;
	}

	get status(): OrderState["status"] {
		return this.state.status;
	}
}

export type PlaceOrderCommand = Command & {
	readonly type: "PlaceOrder";
	readonly customerId: CustomerId;
	readonly correlationId: string;
	readonly idempotency: IdempotentCommitRequest;
	readonly items: ReadonlyArray<PlaceOrderItem>;
};
// #endregion order-domain

// #region place-order-handler
type PlaceOrderOutcome =
	| {
			readonly status: "placed";
			readonly orderId: OrderId;
	  }
	| {
			readonly status: "rejected";
			readonly code: "EMPTY_ORDER";
	  };

interface OrderRepository {
	save(order: Order): Promise<void>;
}

export interface PlaceOrderHandlerDeps<TContext>
	extends WithIdempotentCommitDeps<AnyDomainEvent, TContext> {
	readonly newOrderId: () => OrderId;
	readonly makeOrderRepository: (context: TContext) => OrderRepository;
}

export function createPlaceOrderHandler<TContext>(
	deps: PlaceOrderHandlerDeps<TContext>,
): CommandHandler<PlaceOrderCommand, OrderId, "EMPTY_ORDER"> {
	return async (command) => {
		const outcome = await withIdempotentCommit<
			AnyDomainEvent,
			PlaceOrderOutcome,
			TContext
		>(deps, command.idempotency, async (context, enrollment) => {
			const orders = deps.makeOrderRepository(context);
			const placement = await domainErrorToResult(
				() => Order.place(deps.newOrderId(), command.customerId, command.items),
				[EmptyOrderError],
			);

			if (placement.isErr()) {
				return {
					result: {
						status: "rejected",
						code: placement.error.code,
					} satisfies PlaceOrderOutcome,
					commits: [],
				};
			}

			const order = placement.value;
			await orders.save(order);

			return {
				result: {
					status: "placed",
					orderId: order.id,
				} satisfies PlaceOrderOutcome,
				commits: [enrollment.enrollSaved(order)],
			};
		});

		return outcome.result.status === "rejected"
			? err(outcome.result.code)
			: ok(outcome.result.orderId);
	};
}
// #endregion place-order-handler
