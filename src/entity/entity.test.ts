import { describe, expect, it } from "vitest";
import { HostileStateKeyError } from "../core/errors";
import type { Id } from "../core/id";
import {
	entityIds,
	findEntityById,
	hasEntityId,
	type Identifiable,
	Entity as ProductionEntity,
	removeEntityById,
	replaceEntityById,
	sameEntity,
	updateEntityById,
} from "./entity";

/** White-box fixture only: production subclasses do not widen `state`. */
abstract class Entity<TState, TId extends Id<string>> extends ProductionEntity<
	TState,
	TId
> {
	public override get state(): TState {
		return super.state;
	}
}

type ItemId = Id<"ItemId">;

// Functional usage (simple data, no logic)
type OrderItem = Identifiable<ItemId> & {
	productId: string;
	quantity: number;
};

// Class-based usage (with state and logic)
type OrderItemState = {
	productId: string;
	quantity: number;
};

class OrderItemEntity extends Entity<OrderItemState, ItemId> {
	constructor(id: ItemId, productId: string, quantity: number) {
		const initialState: OrderItemState = { productId, quantity };
		super(id, initialState);
	}

	updateQuantity(newQuantity: number): void {
		this._state = { ...this._state, quantity: newQuantity };
	}

	protected validateState(state: OrderItemState): void {
		if (state.quantity < 0) {
			throw new Error("Quantity cannot be negative");
		}
	}
}

describe("Identifiable<TId> brand-discipline constraint", () => {
	it("type-level: only Id<Tag> brands are accepted, not plain strings", () => {
		// @ts-expect-error: plain string lacks the Id<…> brand
		type _Bad = Identifiable<string>;
		type _Good = Identifiable<Id<"OrderId">>;
		// Smoke usage to prevent dead-code elimination of the type check
		const ok: _Good = { id: "o-1" as Id<"OrderId"> };
		expect(ok.id).toBe("o-1");
	});
});

describe("Entity state encapsulation", () => {
	it("keeps the live state graph inaccessible to consumers", () => {
		class PrivateStateEntity extends ProductionEntity<OrderItemState, ItemId> {
			constructor(id: ItemId) {
				super(id, { productId: "prod-1", quantity: 2 });
			}
		}
		const entity = new PrivateStateEntity("id-1" as ItemId);

		// @ts-expect-error live entity state is an implementation detail;
		// expose domain queries or an immutable DTO instead.
		void entity.state;

		expect(entity.id).toBe("id-1");
	});
});

describe("Entity", () => {
	describe("Functional Pattern (Identifiable)", () => {
		it("should define entity with id", () => {
			const item: OrderItem = {
				id: "item-1" as ItemId,
				productId: "prod-1",
				quantity: 2,
			};

			expect(item.id).toBe("item-1");
			expect(item.productId).toBe("prod-1");
		});

		describe("sameEntity()", () => {
			it("should return true for entities with same ID", () => {
				const item1: OrderItem = {
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
				};
				const item2: OrderItem = {
					id: "item-1" as ItemId,
					productId: "prod-2",
					quantity: 5,
				};

				expect(sameEntity(item1, item2)).toBe(true);
			});

			it("should return false for entities with different IDs", () => {
				const item1: OrderItem = {
					id: "item-1" as ItemId,
					productId: "prod-1",
					quantity: 2,
				};
				const item2: OrderItem = {
					id: "item-2" as ItemId,
					productId: "prod-1",
					quantity: 2,
				};

				expect(sameEntity(item1, item2)).toBe(false);
			});
		});

		describe("findEntityById()", () => {
			it("should find entity by ID", () => {
				const items: OrderItem[] = [
					{
						id: "item-1" as ItemId,
						productId: "prod-1",
						quantity: 2,
					},
					{
						id: "item-2" as ItemId,
						productId: "prod-2",
						quantity: 5,
					},
				];

				const found = findEntityById(items, "item-1" as ItemId);

				expect(found).toBeDefined();
				expect(found?.id).toBe("item-1");
			});
		});
	});

	describe("Class-based Pattern (Entity with State)", () => {
		it("should create entity with id and state", () => {
			const entity = new OrderItemEntity("id-1" as ItemId, "prod-1", 2);

			expect(entity.id).toBe("id-1");
			expect(entity.state.productId).toBe("prod-1");
			expect(entity.state.quantity).toBe(2);
		});

		it("should allow state mutations through methods", () => {
			const entity = new OrderItemEntity("id-1" as ItemId, "prod-1", 2);

			entity.updateQuantity(5);

			expect(entity.state.quantity).toBe(5);
		});

		it("should enforce entity equality by ID using sameEntity()", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			const e2 = new OrderItemEntity("id-1" as ItemId, "prod-2", 2);
			const e3 = new OrderItemEntity("id-2" as ItemId, "prod-1", 1);

			expect(sameEntity(e1, e2)).toBe(true); // Same ID
			expect(sameEntity(e1, e3)).toBe(false); // Different ID
		});

		it("should throw if ID is null or undefined", () => {
			// @ts-expect-error - testing invalid input
			expect(() => new OrderItemEntity(null, "p1", 1)).toThrow(
				"Entity ID cannot be null or undefined",
			);
			// @ts-expect-error - testing invalid input
			expect(() => new OrderItemEntity(undefined, "p1", 1)).toThrow(
				"Entity ID cannot be null or undefined",
			);
		});

		it("calls validateState BEFORE subclass field initializers (constructor-ordering footgun)", () => {
			// Documents the JavaScript/TS constructor ordering: the super() call
			// (Entity's constructor) runs `validateState` BEFORE the subclass's
			// field initializers. A subclass that reads `this.someField` from
			// inside validateState will see `undefined`. Test pins the behavior
			// so the doc warning stays accurate.
			let seenMinQuantity: unknown = "untouched";

			class TrappyEntity extends Entity<{ quantity: number }, Id<"TrappyId">> {
				private readonly minQuantity = 1;
				constructor(id: Id<"TrappyId">, state: { quantity: number }) {
					super(id, state);
				}
				protected validateState(_state: { quantity: number }): void {
					seenMinQuantity = this.minQuantity;
				}
			}

			new TrappyEntity("t-1" as Id<"TrappyId">, { quantity: 5 });

			// The subclass field initializer hadn't run yet at validateState time,
			// so `this.minQuantity` was undefined. DON'T rely on `this` in validateState.
			expect(seenMinQuantity).toBeUndefined();
		});

		it("should call validateState during construction", () => {
			expect(() => new OrderItemEntity("id-1" as ItemId, "prod-1", -5)).toThrow(
				"Quantity cannot be negative",
			);
		});

		it("should have readonly state from outside", () => {
			const entity = new OrderItemEntity("id-1" as ItemId, "prod-1", 2);
			const state = entity.state;

			// TypeScript prevents: state.quantity = 10;
			// But we can verify state is returned
			expect(state.quantity).toBe(2);
		});

		it("does not leak the internal state reference through the getter", () => {
			const entity = new OrderItemEntity("id-1" as ItemId, "prod-1", 2);
			const leaked = entity.state as { quantity: number };

			// Attempt to mutate the returned snapshot, which should not affect the entity
			expect(() => {
				leaked.quantity = 999;
			}).toThrow(); // frozen object → strict-mode TypeError

			expect(entity.state.quantity).toBe(2);
		});

		it("freezes the state shallowly so that direct property writes throw", () => {
			const entity = new OrderItemEntity("id-1" as ItemId, "prod-1", 2);
			const state = entity.state;
			expect(Object.isFrozen(state)).toBe(true);
		});
	});

	describe("caller-owned state objects are not frozen in place", () => {
		type BoxState = { qty: number; meta?: { tag: string } };

		class BoxEntity extends Entity<BoxState, ItemId> {
			constructor(id: ItemId, state: BoxState) {
				super(id, state);
			}

			replace(state: BoxState): void {
				this.setState(state);
			}
		}

		it("does not freeze the caller's initialState", () => {
			const state: BoxState = { qty: 1 };
			const box = new BoxEntity("item-1" as ItemId, state);

			expect(Object.isFrozen(state)).toBe(false);
			state.qty = 2; // caller's object stays mutable...
			expect(box.state.qty).toBe(1); // ...without bleeding into the entity
		});

		it("does not freeze the caller's newState passed via setState", () => {
			const box = new BoxEntity("item-1" as ItemId, { qty: 1 });
			const next: BoxState = { qty: 5 };

			box.replace(next);

			expect(Object.isFrozen(next)).toBe(false);
			next.qty = 9;
			expect(box.state.qty).toBe(5);
		});

		it("keeps the entity's own state shallowly frozen", () => {
			const box = new BoxEntity("item-1" as ItemId, { qty: 1 });

			expect(Object.isFrozen(box.state)).toBe(true);
			expect(() => {
				(box.state as { qty: number }).qty = 99;
			}).toThrow();
		});

		it("keeps nested objects shared and unfrozen (documented shallow-freeze design)", () => {
			const meta = { tag: "a" };
			const box = new BoxEntity("item-1" as ItemId, { qty: 1, meta });

			expect(Object.isFrozen(meta)).toBe(false);
			expect(box.state.meta).toBe(meta);
		});
	});

	describe("hostile state keys (own __proto__ data key)", () => {
		type RawState = Record<string, unknown>;

		class RawStateEntity extends Entity<RawState, ItemId> {
			constructor(id: ItemId, state: RawState) {
				super(id, state);
			}

			replace(state: RawState): void {
				this.setState(state);
			}
		}

		// JSON.parse creates an own "__proto__" DATA key (it never invokes
		// the Object.prototype.__proto__ setter): the shape of any DB row or
		// request body handed to a reconstitute factory. Such a key can never
		// be legitimate domain state; carrying it onward would re-arm
		// prototype pollution in downstream [[Set]]-based consumers.
		const hostileState = (): RawState =>
			JSON.parse('{"qty":1,"__proto__":{"isAdmin":true}}') as RawState;

		it("rejects a JSON-parsed own __proto__ key at construction", () => {
			expect(
				() => new RawStateEntity("item-1" as ItemId, hostileState()),
			).toThrow(HostileStateKeyError);
		});

		it("rejects the key on the setState path and keeps the previous state", () => {
			const entity = new RawStateEntity("item-1" as ItemId, { qty: 0 });

			expect(() => entity.replace(hostileState())).toThrow(
				HostileStateKeyError,
			);

			expect(entity.state.qty).toBe(0);
			expect(Object.hasOwn(entity.state, "__proto__")).toBe(false);
		});

		it("rejects an own __proto__ data key on a null-prototype state", () => {
			const state: RawState = Object.create(null);
			state.qty = 1;
			Object.defineProperty(state, "__proto__", {
				value: { isAdmin: true },
				writable: true,
				enumerable: true,
				configurable: true,
			});

			expect(() => new RawStateEntity("item-1" as ItemId, state)).toThrow(
				HostileStateKeyError,
			);
		});

		it("rejects an own __proto__ data key attached to an array state", () => {
			class ListEntity extends Entity<number[], ItemId> {
				constructor(id: ItemId, state: number[]) {
					super(id, state);
				}
			}
			const state = [1, 2];
			Object.defineProperty(state, "__proto__", {
				value: { isAdmin: true },
				writable: true,
				enumerable: true,
				configurable: true,
			});

			expect(() => new ListEntity("item-1" as ItemId, state)).toThrow(
				HostileStateKeyError,
			);
		});

		it("keeps benign null-prototype states intact", () => {
			const state: RawState = Object.create(null);
			state.qty = 1;

			const entity = new RawStateEntity("item-1" as ItemId, state);

			expect(Object.getPrototypeOf(entity.state)).toBe(null);
			expect(entity.state.qty).toBe(1);
		});
	});

	describe("opt-in deep freeze (deepFreezeState)", () => {
		type DeepState = {
			qty: number;
			meta: { name: string };
			tags: string[];
		};

		class DeepBoxEntity extends Entity<DeepState, ItemId> {
			constructor(id: ItemId, state: DeepState) {
				super(id, state, { deepFreezeState: true });
			}

			rename(name: string): void {
				this.setState({
					...this.state,
					meta: { ...this.state.meta, name },
				});
			}
		}

		it("freezes nested objects and arrays so outside writes throw", () => {
			const box = new DeepBoxEntity("item-1" as ItemId, {
				qty: 1,
				meta: { name: "a" },
				tags: ["x"],
			});

			expect(Object.isFrozen(box.state)).toBe(true);
			expect(Object.isFrozen(box.state.meta)).toBe(true);
			expect(Object.isFrozen(box.state.tags)).toBe(true);
			expect(() => {
				(box.state.meta as { name: string }).name = "hacked";
			}).toThrow();
			expect(() => {
				(box.state.tags as string[]).push("hacked");
			}).toThrow();
			expect(box.state.meta.name).toBe("a");
			expect(box.state.tags).toEqual(["x"]);
		});

		it("applies the deep freeze to states set via setState", () => {
			const box = new DeepBoxEntity("item-1" as ItemId, {
				qty: 1,
				meta: { name: "a" },
				tags: [],
			});

			box.rename("b");

			expect(box.state.meta.name).toBe("b");
			expect(Object.isFrozen(box.state.meta)).toBe(true);
			expect(() => {
				(box.state.meta as { name: string }).name = "hacked";
			}).toThrow();
		});

		it("treats nested input objects as an ownership transfer: they are frozen in place", () => {
			// The shallow copy protects only the TOP-LEVEL input object; with
			// deepFreezeState the nested graph becomes part of the entity's
			// deeply frozen state and is frozen in place. Documented contract.
			const meta = { name: "a" };
			const box = new DeepBoxEntity("item-1" as ItemId, {
				qty: 1,
				meta,
				tags: [],
			});

			expect(Object.isFrozen(meta)).toBe(true);
			expect(box.state.meta).toBe(meta);
		});

		it("stays shallow by default (the opt-in changes nothing for other entities)", () => {
			class ShallowBoxEntity extends Entity<
				{ qty: number; meta: { tag: string } },
				ItemId
			> {
				constructor(id: ItemId, state: { qty: number; meta: { tag: string } }) {
					super(id, state);
				}
			}

			const meta = { tag: "a" };
			const box = new ShallowBoxEntity("item-1" as ItemId, { qty: 1, meta });

			expect(Object.isFrozen(box.state)).toBe(true);
			expect(Object.isFrozen(box.state.meta)).toBe(false);
		});
	});

	describe("Helper functions compatibility", () => {
		it("should work with class instances", () => {
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			const e2 = new OrderItemEntity("id-2" as ItemId, "prod-2", 2);
			const entities = [e1, e2];

			const found = findEntityById(entities, "id-1" as ItemId);
			expect(found).toBe(e1);

			const hasId = hasEntityId(entities, "id-1" as ItemId);
			expect(hasId).toBe(true);

			const ids = entityIds(entities);
			expect(ids).toEqual(["id-1", "id-2"]);

			const updated = updateEntityById(entities, "id-1" as ItemId, (e) => {
				e.updateQuantity(5);
				return e;
			});
			expect(updated[0]!.state.quantity).toBe(5);

			const removed = removeEntityById(entities, "id-1" as ItemId);
			expect(removed).toHaveLength(1);
			expect(removed[0]!.id).toBe("id-2");
		});

		it("accepts ReadonlyArray inputs: callers holding a readonly aggregate state slice don't need to cast", () => {
			// The state slice of a frozen aggregate is typically typed as
			// ReadonlyArray<T>. Helpers must accept it without forcing a
			// copy / cast at the call site.
			const e1 = new OrderItemEntity("id-1" as ItemId, "prod-1", 1);
			const e2 = new OrderItemEntity("id-2" as ItemId, "prod-2", 2);
			const items: ReadonlyArray<OrderItemEntity> = [e1, e2];

			expect(findEntityById(items, "id-1" as ItemId)).toBe(e1);
			expect(hasEntityId(items, "id-2" as ItemId)).toBe(true);
			expect(entityIds(items)).toEqual(["id-1", "id-2"]);
			expect(removeEntityById(items, "id-1" as ItemId)).toHaveLength(1);
			expect(
				replaceEntityById(
					items,
					"id-1" as ItemId,
					new OrderItemEntity("id-1" as ItemId, "prod-1", 99),
				)[0]?.state.quantity,
			).toBe(99);
		});
	});
});

describe("validation sees the stored copy on both paths", () => {
	type ProbeState = { q: number };

	class ProbeEntity extends Entity<ProbeState, ItemId> {
		readonly seen: ProbeState[] = [];
		constructor(initial: ProbeState) {
			super("item-1" as ItemId, initial);
		}
		protected override validateState(state: ProbeState): void {
			// The constructor runs before field initializers; guard the push.
			this.seen?.push(state);
			if (state.q < 0) throw new Error("q must not be negative");
		}
		set(next: ProbeState): void {
			this.setState(next);
		}
	}

	it("setState validates the frozen copy that will be stored, never the caller's object", () => {
		const entity = new ProbeEntity({ q: 1 });
		const raw = { q: 2 };

		entity.set(raw);

		const validated = entity.seen.at(-1);
		expect(validated).not.toBe(raw);
		expect(Object.isFrozen(validated)).toBe(true);
		expect(entity.state).toBe(validated);
	});

	it("a throwing validateState in setState leaves the previous state in place", () => {
		const entity = new ProbeEntity({ q: 1 });

		expect(() => entity.set({ q: -5 })).toThrow("must not be negative");
		expect(entity.state.q).toBe(1);
	});
});

describe("array states keep own non-index keys", () => {
	type Items = number[] & { total?: number };

	class ListEntity extends Entity<Items, ItemId> {
		constructor(state: Items) {
			super("item-1" as ItemId, state);
		}
		replace(next: Items): void {
			this.setState(next);
		}
	}

	const withTotal = (): Items => {
		const items = [1, 2] as Items;
		items.total = 3;
		return items;
	};

	it("preserves an own enumerable non-index key through the constructor copy", () => {
		const entity = new ListEntity(withTotal());

		expect([...entity.state]).toEqual([1, 2]);
		expect(entity.state.total).toBe(3);
	});

	it("preserves the key on the setState path too", () => {
		const entity = new ListEntity([0] as Items);

		entity.replace(withTotal());

		expect(entity.state.total).toBe(3);
	});
});

describe("collection helpers preserve reference identity when nothing changed", () => {
	// changedKeys is a reference diff: a helper returning a NEW array for
	// a no-op would mark the state key dirty and trigger a pointless
	// partial write. New array if and only if an element reference changed.
	type Item = Identifiable<ItemId> & { qty: number };
	const items = (): Item[] => [
		{ id: "i-1" as ItemId, qty: 1 },
		{ id: "i-2" as ItemId, qty: 2 },
	];

	it("updateEntityById returns the original array when no id matched", () => {
		const source = items();
		expect(updateEntityById(source, "i-9" as ItemId, (e) => ({ ...e }))).toBe(
			source,
		);
	});

	it("updateEntityById returns the original array when the updater is a no-op", () => {
		const source = items();
		expect(updateEntityById(source, "i-1" as ItemId, (e) => e)).toBe(source);
	});

	it("updateEntityById returns a fresh array on a real change, keeping sibling identity", () => {
		const source = items();
		const updated = updateEntityById(source, "i-1" as ItemId, (e) => ({
			...e,
			qty: 9,
		}));

		expect(updated).not.toBe(source);
		expect(updated[0]?.qty).toBe(9);
		expect(updated[1]).toBe(source[1]);
		expect(source[0]?.qty).toBe(1);
	});

	it("replaceEntityById returns the original array for a same-reference replacement or a miss", () => {
		const source = items();
		const first = source[0] as Item;

		expect(replaceEntityById(source, "i-1" as ItemId, first)).toBe(source);
		expect(
			replaceEntityById(source, "i-9" as ItemId, {
				id: "i-9" as ItemId,
				qty: 0,
			}),
		).toBe(source);
	});

	it("removeEntityById returns the original array when the id is absent", () => {
		const source = items();
		expect(removeEntityById(source, "i-9" as ItemId)).toBe(source);
		expect(removeEntityById(source, "i-1" as ItemId)).toHaveLength(1);
	});
});
