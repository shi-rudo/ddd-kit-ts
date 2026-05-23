import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { IQueryableRepository, IRepository } from "./repository";
import { AggregateNotFoundError } from "../core/errors";

type OrderId = Id<"OrderId">;
type Order = IAggregateRoot<OrderId> & {
	readonly customerId: string;
	readonly total: number;
};

describe("Repository contract", () => {
	describe("IRepository — id-only access", () => {
		it("can be implemented by a write-side repo without any querying", async () => {
			class InMemoryOrders implements IRepository<Order, OrderId> {
				private readonly byId = new Map<OrderId, Order>();

				async getById(id: OrderId): Promise<Order | null> {
					return this.byId.get(id) ?? null;
				}

				async getByIdOrFail(id: OrderId): Promise<Order> {
					const existing = this.byId.get(id);
					if (!existing) {
						throw new AggregateNotFoundError("Order", id);
					}
					return existing;
				}

				async save(aggregate: Order): Promise<void> {
					this.byId.set(aggregate.id, aggregate);
				}

				async delete(id: OrderId): Promise<void> {
					this.byId.delete(id);
				}
			}

			const repo = new InMemoryOrders();
			const order: Order = {
				id: "o-1" as OrderId,
				version: 1 as never,
				customerId: "c-1",
				total: 100,
			};
			await repo.save(order);

			expect(await repo.getById("o-1" as OrderId)).toBe(order);
			expect(await repo.getById("o-missing" as OrderId)).toBeNull();
			await expect(
				repo.getByIdOrFail("o-missing" as OrderId),
			).rejects.toBeInstanceOf(AggregateNotFoundError);
		});
	});

	describe("IQueryableRepository — owns its filter language", () => {
		it("accepts an in-memory predicate filter", async () => {
			type Predicate<T> = (t: T) => boolean;

			class InMemoryQueryableOrders
				implements IQueryableRepository<Order, OrderId, Predicate<Order>>
			{
				private readonly byId = new Map<OrderId, Order>();

				async getById(id: OrderId): Promise<Order | null> {
					return this.byId.get(id) ?? null;
				}
				async getByIdOrFail(id: OrderId): Promise<Order> {
					const existing = this.byId.get(id);
					if (!existing) throw new AggregateNotFoundError("Order", id);
					return existing;
				}
				async save(aggregate: Order): Promise<void> {
					this.byId.set(aggregate.id, aggregate);
				}
				async delete(id: OrderId): Promise<void> {
					this.byId.delete(id);
				}
				async findOne(filter: Predicate<Order>): Promise<Order | null> {
					for (const o of this.byId.values()) if (filter(o)) return o;
					return null;
				}
				async find(filter: Predicate<Order>): Promise<Order[]> {
					return [...this.byId.values()].filter(filter);
				}
			}

			const repo = new InMemoryQueryableOrders();
			await repo.save({
				id: "o-1" as OrderId,
				version: 1 as never,
				customerId: "c-1",
				total: 100,
			});
			await repo.save({
				id: "o-2" as OrderId,
				version: 1 as never,
				customerId: "c-2",
				total: 250,
			});

			const found = await repo.find((o) => o.total > 200);
			expect(found).toHaveLength(1);
			expect(found[0]?.customerId).toBe("c-2");

			const single = await repo.findOne((o) => o.customerId === "c-1");
			expect(single?.id).toBe("o-1");
		});

		it("accepts a structural filter type (analogue to Prisma WhereInput)", () => {
			type OrderFilter = { customerId?: string; minTotal?: number };

			// Compile-time only: the type is preserved end-to-end.
			class StructuralOrders
				implements IQueryableRepository<Order, OrderId, OrderFilter>
			{
				async getById(): Promise<Order | null> {
					return null;
				}
				async getByIdOrFail(id: OrderId): Promise<Order> {
					throw new AggregateNotFoundError("Order", id);
				}
				async save(): Promise<void> {}
				async delete(): Promise<void> {}
				async findOne(_filter: OrderFilter): Promise<Order | null> {
					return null;
				}
				async find(_filter: OrderFilter): Promise<Order[]> {
					return [];
				}
			}

			const repo = new StructuralOrders();
			// This should typecheck — the structural filter survives.
			void repo.find({ customerId: "c-1", minTotal: 100 });
		});
	});
});
