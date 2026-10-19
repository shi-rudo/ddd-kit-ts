import {
	CommandBus,
	createDomainEvent,
	createDomainEventFactory,
	copyPlainState,
	InMemoryEventStore,
	stampPendingEvents,
	StateStoredAggregate,
} from "@shirudo/ddd-kit";
import { addMoney, moneyOfMinor, moneyToDto } from "@shirudo/ddd-kit/money";
import { ok } from "@shirudo/result";

class EdgeOrder extends StateStoredAggregate {
	aggregateType = "EdgeOrder";

	constructor() {
		super("order-edge-1", { status: "draft" });
	}

	confirm() {
		this.setState(
			{ status: "confirmed" },
			this.createEvent("EdgeOrderConfirmed", { orderId: this.id }),
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
	order.confirm();
	// The v3 flow: the aggregate produces the unstamped decision, the
	// application shell stamps it with the factory before persistence.
	const domainEvents = createDomainEventFactory();
	stampPendingEvents(order, domainEvents);
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

	// A runtime can return a structured clone from another realm. The plain
	// data check of the kit must accept it, and the event store must accept
	// the event that the kit minted.
	const copy = copyPlainState(structuredClone({ line: { sku: "a", qty: 1 } }));
	assert(copy.line.qty === 1, "copyPlainState rejected a structured clone");
	const events = new InMemoryEventStore();
	const stream = { aggregateType: "EdgeOrder", aggregateId: order.id };
	await events.append(stream, [orderView.pendingEvent], { expectedVersion: 0 });
	const history = await events.readStream(stream, { limit: 10 });
	assert(history.lastVersion === 1, "event store did not keep the event");

	// The metadata check must accept a copy from another realm too.
	const traced = createDomainEventFactory({ source: "edge-smoke" }).create(
		"EdgeOrderTraced",
		{ orderId: order.id },
		{ metadata: { correlationId: "corr-1" } },
	);
	assert(
		traced.metadata?.source === "edge-smoke" &&
			traced.metadata?.correlationId === "corr-1",
		"the factory lost the metadata or its source",
	);
	const correlated = createDomainEvent(
		"EdgeOrderCorrelated",
		{ orderId: order.id },
		{ metadata: { correlationId: "corr-2" } },
	);
	await events.append(stream, [traced, correlated], { expectedVersion: 1 });

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
