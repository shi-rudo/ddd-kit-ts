import {
	AggregateRoot,
	CommandBus,
	createDomainEventFactory,
} from "@shirudo/ddd-kit";
import { addMoney, moneyOfMinor, moneyToDto } from "@shirudo/ddd-kit/money";
import { ok } from "@shirudo/result";

class EdgeOrder extends AggregateRoot {
	aggregateType = "EdgeOrder";

	constructor() {
		super("order-edge-1", { status: "draft" });
	}

	confirm(facts) {
		this.commit(
			{ status: "confirmed" },
			this.recordEvent("EdgeOrderConfirmed", { orderId: this.id }, facts),
		);
	}

	toView() {
		return Object.freeze({
			status: this.state.status,
			version: this.version,
			pendingEvent: this.pendingEvents[0],
		});
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

export async function runEdgeRuntimeSmoke(runtime) {
	assert(
		typeof globalThis.process === "undefined",
		`${runtime} unexpectedly exposes the Node process global`,
	);
	assert(
		typeof globalThis.Buffer === "undefined",
		`${runtime} unexpectedly exposes the Node Buffer global`,
	);

	const order = new EdgeOrder();
	const domainEvents = createDomainEventFactory();
	order.confirm(domainEvents.createFacts());
	const orderView = order.toView();
	assert(orderView.status === "confirmed", "aggregate state did not change");
	assert(orderView.version === 1, "aggregate version did not advance");
	assert(
		orderView.pendingEvent?.type === "EdgeOrderConfirmed",
		"aggregate did not record its domain event",
	);
	assert(
		Object.isFrozen(orderView.pendingEvent.payload),
		"domain-event payload is not frozen",
	);

	const bus = new CommandBus();
	bus.register("ReadOrder", async () => ok(orderView));
	const busResult = await bus.execute({ type: "ReadOrder" });
	assert(busResult.isOk(), "command bus did not return an Ok result");
	assert(
		busResult.value.status === "confirmed",
		"command bus returned the wrong aggregate view",
	);

	const total = addMoney(
		moneyOfMinor(1099n, "EUR", 2),
		moneyOfMinor(201n, "EUR", 2),
	);
	const totalDto = moneyToDto(total);
	assert(totalDto.amountMinor === "1300", "money addition lost precision");
	assert(totalDto.currency === "EUR", "money currency changed");
	assert(totalDto.scale === 2, "money scale changed");

	return Object.freeze({
		ok: true,
		runtime,
		aggregateVersion: orderView.version,
		eventType: orderView.pendingEvent.type,
		money: totalDto,
	});
}
