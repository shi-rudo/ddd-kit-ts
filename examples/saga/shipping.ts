import { AggregateRoot } from "../../src/aggregate/aggregate-root";
import {
	createDomainEvent,
	type DomainEvent,
} from "../../src/aggregate/domain-event";
import { DomainError } from "../../src/core/errors";
import type { Id } from "../../src/core/id";
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

export class ShipmentInWrongStateError extends DomainError<"ShipmentInWrongStateError"> {
	constructor(shipmentId: ShipmentId, current: string, attempted: string) {
		super(`Shipment ${shipmentId} is ${current}; cannot ${attempted}`);
	}
}

export class Shipment extends AggregateRoot<
	ShipmentState,
	ShipmentId,
	ShippingEvent
> {
	static request(id: ShipmentId, orderId: OrderId): Shipment {
		const shipment = new Shipment(id, { id, orderId, status: "requested" });
		shipment.commit(
			{ id, orderId, status: "requested" },
			createDomainEvent(
				"ShippingRequested",
				{ orderId },
				{ aggregateId: id, aggregateType: "Shipment" },
			),
		);
		return shipment;
	}

	complete(trackingId: string): void {
		if (this.state.status !== "requested") {
			throw new ShipmentInWrongStateError(this.id, this.state.status, "complete");
		}
		this.commit(
			{ ...this.state, status: "shipped", trackingId },
			createDomainEvent(
				"ShippingCompleted",
				{ orderId: this.state.orderId, trackingId },
				{ aggregateId: this.id, aggregateType: "Shipment" },
			),
		);
	}

	fail(reason: string): void {
		if (this.state.status !== "requested") {
			throw new ShipmentInWrongStateError(this.id, this.state.status, "fail");
		}
		this.commit(
			{ ...this.state, status: "failed", failureReason: reason },
			createDomainEvent(
				"ShippingFailed",
				{ orderId: this.state.orderId, reason },
				{ aggregateId: this.id, aggregateType: "Shipment" },
			),
		);
	}
}
