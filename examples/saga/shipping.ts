import { AggregateRoot } from "../../src/domain/aggregate/aggregate-root";
import type { DomainEvent } from "../../src/domain/event/domain-event";
import type { Id } from "../../src/domain/identity/id";
import { DomainError } from "../../src/errors/kit-errors";
import type { OrderId } from "./order";

export type ShipmentId = Id<"ShipmentId">;

export type ShipmentState = {
	id: ShipmentId;
	orderId: OrderId;
	status: "requested" | "shipped" | "failed";
	trackingId?: string;
	failureReason?: string;
};

export type ShippingRequested = DomainEvent<
	"ShippingRequested",
	{ orderId: OrderId }
>;
export type ShippingCompleted = DomainEvent<
	"ShippingCompleted",
	{ orderId: OrderId; trackingId: string }
>;
export type ShippingFailed = DomainEvent<
	"ShippingFailed",
	{ orderId: OrderId; reason: string }
>;

export type ShippingEvent =
	| ShippingRequested
	| ShippingCompleted
	| ShippingFailed;

export class ShipmentInWrongStateError extends DomainError<"SHIPMENT_IN_WRONG_STATE"> {
	constructor(shipmentId: ShipmentId, current: string, attempted: string) {
		super({
			code: "SHIPMENT_IN_WRONG_STATE",
			message: `Shipment ${shipmentId} is ${current}; cannot ${attempted}`,
		});
	}
}

export class Shipment extends AggregateRoot<
	ShipmentState,
	ShipmentId,
	ShippingEvent
> {
	protected readonly aggregateType = "Shipment";

	get status(): ShipmentState["status"] {
		return this.state.status;
	}

	get trackingId(): string | undefined {
		return this.state.trackingId;
	}

	static request(id: ShipmentId, orderId: OrderId): Shipment {
		const shipment = new Shipment(id, { id, orderId, status: "requested" });
		shipment.setState(
			{ id, orderId, status: "requested" },
			shipment.createEvent("ShippingRequested", { orderId }),
		);
		return shipment;
	}

	complete(trackingId: string): void {
		if (this.state.status !== "requested") {
			throw new ShipmentInWrongStateError(
				this.id,
				this.state.status,
				"complete",
			);
		}
		this.setState(
			{ ...this.state, status: "shipped", trackingId },
			this.createEvent("ShippingCompleted", {
				orderId: this.state.orderId,
				trackingId,
			}),
		);
	}

	fail(reason: string): void {
		if (this.state.status !== "requested") {
			throw new ShipmentInWrongStateError(this.id, this.state.status, "fail");
		}
		this.setState(
			{ ...this.state, status: "failed", failureReason: reason },
			this.createEvent("ShippingFailed", {
				orderId: this.state.orderId,
				reason,
			}),
		);
	}
}
