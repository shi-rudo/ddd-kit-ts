import { describe, expect, it } from "vite-plus/test";
import { AggregateDeletedError } from "../core/errors";
import type { Id } from "../core/id";
import { IdentityMap } from "./identity-map";

type RestaurantId = Id<"RestaurantId">;
type BookingId = Id<"BookingId">;

class Restaurant {
	constructor(public readonly id: RestaurantId) {}
}

class Booking {
	constructor(public readonly id: BookingId) {}
}

describe("IdentityMap", () => {
	it("get/set/has roundtrip, typed by the class key", () => {
		const map = new IdentityMap();
		const id = "r-1" as RestaurantId;
		const restaurant = new Restaurant(id);

		expect(map.has(Restaurant, id)).toBe(false);
		expect(map.get(Restaurant, id)).toBeUndefined();

		map.set(Restaurant, id, restaurant);

		expect(map.has(Restaurant, id)).toBe(true);
		// get() returns the instance typed as Restaurant - no cast needed.
		const cached = map.get(Restaurant, id);
		expect(cached).toBe(restaurant);
	});

	it("re-registering the SAME instance is a no-op", () => {
		const map = new IdentityMap();
		const id = "r-1" as RestaurantId;
		const restaurant = new Restaurant(id);

		map.set(Restaurant, id, restaurant);
		expect(() => map.set(Restaurant, id, restaurant)).not.toThrow();
		expect(map.get(Restaurant, id)).toBe(restaurant);
	});

	it("registering a DIFFERENT instance for an occupied type+id throws (identity-map violation)", () => {
		const map = new IdentityMap();
		const id = "r-1" as RestaurantId;
		map.set(Restaurant, id, new Restaurant(id));

		expect(() => map.set(Restaurant, id, new Restaurant(id))).toThrow(
			/different instance is already registered for Restaurant\(r-1\)/,
		);
	});

	it("different aggregate types with the same id do not collide", () => {
		const map = new IdentityMap();
		const restaurant = new Restaurant("123" as RestaurantId);
		const booking = new Booking("123" as BookingId);

		map.set(Restaurant, restaurant.id, restaurant);
		map.set(Booking, booking.id, booking);

		expect(map.get(Restaurant, "123" as RestaurantId)).toBe(restaurant);
		expect(map.get(Booking, "123" as BookingId)).toBe(booking);
	});

	it("delete removes the entry and reports absence", () => {
		const map = new IdentityMap();
		const id = "r-1" as RestaurantId;
		map.set(Restaurant, id, new Restaurant(id));

		map.delete(Restaurant, id);

		expect(map.has(Restaurant, id)).toBe(false);
		expect(map.get(Restaurant, id)).toBeUndefined();
	});

	it("set after delete of the same type+id throws AggregateDeletedError (deletion is final)", () => {
		const map = new IdentityMap();
		const id = "r-1" as RestaurantId;
		map.set(Restaurant, id, new Restaurant(id));
		map.delete(Restaurant, id);

		expect(() => map.set(Restaurant, id, new Restaurant(id))).toThrow(
			AggregateDeletedError,
		);
	});

	it("the tombstone is type-scoped: deleting Restaurant(123) does not block Booking(123)", () => {
		const map = new IdentityMap();
		map.set(Restaurant, "123" as RestaurantId, new Restaurant("123" as RestaurantId));
		map.delete(Restaurant, "123" as RestaurantId);

		const booking = new Booking("123" as BookingId);
		expect(() => map.set(Booking, booking.id, booking)).not.toThrow();
		expect(map.get(Booking, booking.id)).toBe(booking);
	});

	it("delete works for a never-registered type+id (tombstone guards deferred-write repos)", () => {
		const map = new IdentityMap();
		const id = "r-9" as RestaurantId;

		expect(() => map.delete(Restaurant, id)).not.toThrow();
		expect(() => map.set(Restaurant, id, new Restaurant(id))).toThrow(
			AggregateDeletedError,
		);
	});

	it("accepts classes with protected constructors as type keys (the kit's aggregate convention)", () => {
		// AggregateRoot mandates `protected constructor` + static factories;
		// a construct-signature key type would reject every guide-conformant
		// aggregate at compile time (TS2345). The prototype-witness branch
		// of AggregateClass is what makes this compile.
		class GuardedAggregate {
			protected constructor(public readonly id: RestaurantId) {}
			static reconstitute(id: RestaurantId): GuardedAggregate {
				return new GuardedAggregate(id);
			}
		}
		const map = new IdentityMap();
		const id = "g-1" as RestaurantId;
		const agg = GuardedAggregate.reconstitute(id);

		map.set(GuardedAggregate, id, agg);

		expect(map.get(GuardedAggregate, id)).toBe(agg);
		expect(map.has(GuardedAggregate, id)).toBe(true);
		map.delete(GuardedAggregate, id);
		expect(map.isDeleted(GuardedAggregate, id)).toBe(true);
	});

	it("isDeleted distinguishes 'deleted in this UoW' from 'never loaded'", () => {
		const map = new IdentityMap();
		const id = "r-1" as RestaurantId;

		expect(map.isDeleted(Restaurant, id)).toBe(false); // never loaded

		map.set(Restaurant, id, new Restaurant(id));
		expect(map.isDeleted(Restaurant, id)).toBe(false); // live

		map.delete(Restaurant, id);
		expect(map.isDeleted(Restaurant, id)).toBe(true); // deleted
		// has()/get() report plain absence; isDeleted is the read path's
		// signal to return null instead of re-hydrating.
		expect(map.has(Restaurant, id)).toBe(false);
	});

	it("isDeleted is type-scoped like the tombstones", () => {
		const map = new IdentityMap();
		map.delete(Restaurant, "123" as RestaurantId);

		expect(map.isDeleted(Restaurant, "123" as RestaurantId)).toBe(true);
		expect(map.isDeleted(Booking, "123" as BookingId)).toBe(false);
	});

	it("clear empties stores AND tombstones", () => {
		const map = new IdentityMap();
		const id = "r-1" as RestaurantId;
		map.set(Restaurant, id, new Restaurant(id));
		map.delete(Restaurant, id);

		map.clear();

		expect(map.has(Restaurant, id)).toBe(false);
		// Tombstones are per-operation state; after clear (= a new
		// lifetime) the type+id is registrable again.
		expect(() => map.set(Restaurant, id, new Restaurant(id))).not.toThrow();
	});
});

describe("clear() resets the pending-event baselines", () => {
	class EventfulAggregate {
		pendingEvents: unknown[] = [];
		constructor(public readonly id: RestaurantId) {}
	}

	it("re-registering the same instance after clear() captures a fresh baseline", () => {
		const map = new IdentityMap();
		const id = "r-1" as RestaurantId;
		const aggregate = new EventfulAggregate(id);
		aggregate.pendingEvents = [{}, {}];

		map.set(EventfulAggregate, id, aggregate);
		map.clear();

		// The instance was flushed elsewhere; a REUSED map must capture the
		// new, lower baseline instead of keeping the stale count of 2,
		// which would hide the next recorded event from the
		// UnenrolledChangesError safety net.
		aggregate.pendingEvents = [];
		map.set(EventfulAggregate, id, aggregate);
		aggregate.pendingEvents = [{}];

		expect(map.instancesWithNewPendingEvents()).toHaveLength(1);
	});
});
