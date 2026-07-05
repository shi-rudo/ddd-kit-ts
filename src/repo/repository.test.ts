import { isBaseError } from "@shirudo/base-error";
import { describe, expect, it } from "vitest";
import type { Version } from "../aggregate/aggregate";
import type { IAggregateRoot } from "../aggregate/aggregate-root";
import {
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DomainError,
	InfrastructureError,
} from "../core/errors";
import type { Id } from "../core/id";
import type { IQueryableRepository, IRepository } from "./repository";

type OrderId = Id<"OrderId">;
type Order = IAggregateRoot<OrderId> & {
	readonly customerId: string;
	readonly total: number;
};

describe("IAggregateRoot interface contract", () => {
	it("declares markPersisted so Repository.save can call it through the interface", () => {
		// What a Repository.save implementer actually does after persisting:
		// push the new version back into the aggregate. That call has to
		// type-check against IAggregateRoot (the interface), not against
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
			pendingEvents: [],
			clearPendingEvents: () => {},
			persistedVersion: undefined,
		};
		postSave(stub, 1 as Version);
		expect(typeof stub.markPersisted).toBe("function");
	});
});

describe("Repository contract", () => {
	describe("IRepository: id-only access", () => {
		it("can be implemented by a write-side repo without any querying", async () => {
			class InMemoryOrders implements IRepository<Order, OrderId> {
				private readonly byId = new Map<OrderId, Order>();

				async getById(id: OrderId): Promise<Order | null> {
					return this.byId.get(id) ?? null;
				}

				async getByIdOrFail(id: OrderId): Promise<Order> {
					const existing = this.byId.get(id);
					if (!existing) {
						throw new AggregateNotFoundError({ aggregateType: "Order", id });
					}
					return existing;
				}

				async exists(id: OrderId): Promise<boolean> {
					return this.byId.has(id);
				}

				async save(aggregate: Order): Promise<void> {
					this.byId.set(aggregate.id, aggregate);
				}

				async delete(aggregate: Order): Promise<void> {
					this.byId.delete(aggregate.id);
				}
			}

			const repo = new InMemoryOrders();
			const order: Order = {
				id: "o-1" as OrderId,
				version: 1 as never,
				customerId: "c-1",
				total: 100,
				markPersisted: () => {},
				pendingEvents: [],
				clearPendingEvents: () => {},
				persistedVersion: undefined,
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

	describe("delete contract (v3: one shape across both repository interfaces)", () => {
		it("type-level: an id-only delete implementation no longer conforms", () => {
			// v3 unified delete on the aggregate-taking shape: deletion-event
			// harvest, the identity-map tombstone, and an OCC predicate all
			// need the instance, which a bare id cannot provide.
			class V2ShapedRepo implements IRepository<Order, OrderId> {
				async getById(): Promise<Order | null> {
					return null;
				}
				async getByIdOrFail(id: OrderId): Promise<Order> {
					throw new AggregateNotFoundError({ aggregateType: "Order", id });
				}
				async exists(): Promise<boolean> {
					return false;
				}
				async save(): Promise<void> {}
				// @ts-expect-error v3 contract: delete takes the aggregate, not the bare id
				async delete(id: OrderId): Promise<void> {
					void id;
				}
			}
			expect(new V2ShapedRepo()).toBeDefined();
		});
	});

	describe("@shirudo/base-error integration", () => {
		it("library errors carry timestamp + name from BaseError", () => {
			const before = Date.now();
			const e = new AggregateNotFoundError({
				aggregateType: "Order",
				id: "o-1",
			});
			const after = Date.now();

			expect(e.name).toBe("AGGREGATE_NOT_FOUND");
			expect(e.timestamp).toBeGreaterThanOrEqual(before);
			expect(e.timestamp).toBeLessThanOrEqual(after);
			expect(typeof e.timestampIso).toBe("string");
		});

		it("AggregateNotFoundError carries the aggregate type and id in its technical message", () => {
			const e = new AggregateNotFoundError({
				aggregateType: "Order",
				id: "o-1",
			});

			expect(e.message).toContain("Order(o-1)"); // technical
		});

		it("ConcurrencyConflictError marks itself retryable via @shirudo/base-error isRetryable", async () => {
			const { isRetryable } = await import("@shirudo/base-error");
			const e = new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 3,
				actualVersion: 5,
			});

			expect(e.retryable).toBe(true);
			expect(isRetryable(e)).toBe(true);
		});

		it("AggregateNotFoundError is NOT retryable (the row isn't there; retry won't help)", async () => {
			const { isRetryable } = await import("@shirudo/base-error");
			const e = new AggregateNotFoundError({
				aggregateType: "Order",
				id: "o-1",
			});

			expect(isRetryable(e)).toBe(false);
		});

		it("library errors serialise to JSON for structured logging", () => {
			const e = new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 3,
				actualVersion: 5,
			});
			const json = e.toJSON();

			expect(json.name).toBe("CONCURRENCY_CONFLICT");
			expect(json.message).toContain("Order(o-1)");
			expect(json.timestamp).toBeDefined();
		});

		it("wrapping a library error in a use-case error preserves the cause chain", async () => {
			const { getRootCause, findInCauseChain, isRetryable } = await import(
				"@shirudo/base-error"
			);

			class FailedToProcessOrderError extends DomainError<"FAILED_TO_PROCESS_ORDER"> {
				constructor(cause: unknown) {
					super({
						code: "FAILED_TO_PROCESS_ORDER",
						message: "Failed to process order",
						cause,
					});
				}
			}

			const root = new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 3,
				actualVersion: 5,
			});
			const wrapped = new FailedToProcessOrderError(root);

			expect(getRootCause(wrapped)).toBe(root);
			expect(
				findInCauseChain(wrapped, (e) => e instanceof ConcurrencyConflictError),
			).toBe(root);
			// The retryable hint survives the wrap: walk the chain or
			// inspect the root to decide whether to retry the use case.
			expect(isRetryable(getRootCause(wrapped))).toBe(true);
		});
	});

	describe("Error hierarchy: InfrastructureError vs DomainError", () => {
		it("AggregateNotFoundError is an InfrastructureError, not a DomainError", () => {
			const error = new AggregateNotFoundError({
				aggregateType: "Order",
				id: "o-1",
			});
			expect(error).toBeInstanceOf(InfrastructureError);
			expect(isBaseError(error)).toBe(true);
			expect(error).not.toBeInstanceOf(DomainError);
		});

		it("ConcurrencyConflictError is an InfrastructureError, not a DomainError", () => {
			const error = new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 3,
				actualVersion: 5,
			});
			expect(error).toBeInstanceOf(InfrastructureError);
			expect(isBaseError(error)).toBe(true);
			expect(error).not.toBeInstanceOf(DomainError);
		});

		it("a consumer-derived DomainError is NOT an InfrastructureError", () => {
			class OrderAlreadyConfirmedError extends DomainError<"ORDER_ALREADY_CONFIRMED"> {
				constructor() {
					super({
						code: "ORDER_ALREADY_CONFIRMED",
						message: "Order already confirmed",
					});
				}
			}
			const e = new OrderAlreadyConfirmedError();
			expect(e).toBeInstanceOf(DomainError);
			expect(isBaseError(e)).toBe(true);
			expect(e).not.toBeInstanceOf(InfrastructureError);
		});
	});

	describe("ConcurrencyConflictError contract", () => {
		it("carries aggregate type, id, expected and actual versions", () => {
			const error = new ConcurrencyConflictError({
				aggregateType: "Order",
				aggregateId: "o-1",
				expectedVersion: 3,
				actualVersion: 5,
			});
			expect(error).toBeInstanceOf(InfrastructureError);
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
					throw new AggregateNotFoundError({ aggregateType: "Order", id });
				}
				async exists(): Promise<boolean> {
					return false;
				}
				async save(aggregate: Order): Promise<void> {
					throw new ConcurrencyConflictError({
						aggregateType: "Order",
						aggregateId: aggregate.id,
						expectedVersion: aggregate.version as unknown as number,
						actualVersion: (aggregate.version as unknown as number) + 1,
					});
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
					pendingEvents: [],
					clearPendingEvents: () => {},
					persistedVersion: undefined,
				}),
			).rejects.toBeInstanceOf(ConcurrencyConflictError);
		});
	});

	describe("IQueryableRepository: owns its filter language", () => {
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
					if (!existing)
						throw new AggregateNotFoundError({ aggregateType: "Order", id });
					return existing;
				}
				async exists(id: OrderId): Promise<boolean> {
					return this.byId.has(id);
				}
				async save(aggregate: Order): Promise<void> {
					this.byId.set(aggregate.id, aggregate);
				}
				async delete(aggregate: Order): Promise<void> {
					this.byId.delete(aggregate.id);
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
				pendingEvents: [],
				clearPendingEvents: () => {},
				persistedVersion: undefined,
			});
			await repo.save({
				id: "o-2" as OrderId,
				version: 1 as never,
				customerId: "c-2",
				total: 250,
				markPersisted: () => {},
				pendingEvents: [],
				clearPendingEvents: () => {},
				persistedVersion: undefined,
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
					throw new AggregateNotFoundError({ aggregateType: "Order", id });
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
			// This should typecheck: the structural filter survives.
			void repo.find({ customerId: "c-1", minTotal: 100 });
		});
	});
});
