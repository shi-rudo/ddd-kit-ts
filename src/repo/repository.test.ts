import { describe, expect, it } from "vitest";
import type { Id } from "../core/id";
import type { IAggregateRoot } from "../aggregate/aggregate-root";
import type { Version } from "../aggregate/aggregate";
import type { IQueryableRepository, IRepository } from "./repository";
import {
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DomainError,
} from "../core/errors";

type OrderId = Id<"OrderId">;
type Order = IAggregateRoot<OrderId> & {
	readonly customerId: string;
	readonly total: number;
};

describe("IAggregateRoot interface contract", () => {
	it("declares markPersisted so Repository.save can call it through the interface", () => {
		// What a Repository.save implementer actually does after persisting:
		// push the new version back into the aggregate. That call has to
		// type-check against IAggregateRoot — the interface — not against
		// the abstract class. If markPersisted only existed on the class,
		// this function below would not compile.
		function postSave<TId extends Id<string>, A extends IAggregateRoot<TId>>(
			agg: A,
			persistedVersion: Version,
		): void {
			agg.markPersisted(persistedVersion);
		}

		// Smoke-call to keep the function referenced (otherwise dead-code
		// elimination at runtime hides the compile-time pin).
		const stub: IAggregateRoot<OrderId> = {
			id: "o-1" as OrderId,
			version: 0 as Version,
			markPersisted: () => {},
		};
		postSave(stub, 1 as Version);
		expect(typeof stub.markPersisted).toBe("function");
	});
});

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

				async exists(id: OrderId): Promise<boolean> {
					return this.byId.has(id);
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
				markPersisted: () => {},
			};

			expect(await repo.exists("o-1" as OrderId)).toBe(false);

			await repo.save(order);

			expect(await repo.exists("o-1" as OrderId)).toBe(true);
			expect(await repo.exists("o-missing" as OrderId)).toBe(false);
			expect(await repo.getById("o-1" as OrderId)).toBe(order);
			expect(await repo.getById("o-missing" as OrderId)).toBeNull();
			await expect(
				repo.getByIdOrFail("o-missing" as OrderId),
			).rejects.toBeInstanceOf(AggregateNotFoundError);
		});
	});

	describe("ConcurrencyConflictError contract", () => {
		it("carries aggregate type, id, expected and actual versions", () => {
			const error = new ConcurrencyConflictError("Order", "o-1", 3, 5);
			expect(error).toBeInstanceOf(DomainError);
			expect(error.aggregateType).toBe("Order");
			expect(error.aggregateId).toBe("o-1");
			expect(error.expectedVersion).toBe(3);
			expect(error.actualVersion).toBe(5);
			expect(error.message).toContain("Order(o-1)");
			expect(error.message).toContain("expected version 3");
			expect(error.message).toContain("actual 5");
		});

		it("is the canonical error a Repository.save() implementation throws on optimistic-lock mismatch", () => {
			// Smoke check: a Repository implementation can construct + throw it.
			class StaleRepo implements IRepository<Order, OrderId> {
				async getById(): Promise<Order | null> {
					return null;
				}
				async getByIdOrFail(id: OrderId): Promise<Order> {
					throw new AggregateNotFoundError("Order", id);
				}
				async exists(): Promise<boolean> {
					return false;
				}
				async save(aggregate: Order): Promise<void> {
					throw new ConcurrencyConflictError(
						"Order",
						aggregate.id,
						aggregate.version as unknown as number,
						(aggregate.version as unknown as number) + 1,
					);
				}
				async delete(): Promise<void> {}
			}

			const repo = new StaleRepo();
			return expect(
				repo.save({
					id: "o-1" as OrderId,
					version: 3 as never,
					customerId: "c-1",
					total: 100,
					markPersisted: () => {},
				}),
			).rejects.toBeInstanceOf(ConcurrencyConflictError);
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
				async exists(id: OrderId): Promise<boolean> {
					return this.byId.has(id);
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
				markPersisted: () => {},
			});
			await repo.save({
				id: "o-2" as OrderId,
				version: 1 as never,
				customerId: "c-2",
				total: 250,
				markPersisted: () => {},
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
				async exists(): Promise<boolean> {
					return false;
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
