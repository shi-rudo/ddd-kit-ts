import { isBaseError } from "@shirudo/base-error";
import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error IQueryableRepository was removed from the public API;
// consumer applications own domain-specific query repository ports instead.
import type { IQueryableRepository as RemovedQueryableRepository } from "../..";
import {
	AggregateNotFoundError,
	ConcurrencyConflictError,
	DomainError,
	InfrastructureError,
} from "../../core/errors";
import type { Version } from "../../domain/aggregate/aggregate";
import type { IAggregateRoot } from "../../domain/aggregate/aggregate-root";
import type { Id } from "../../domain/identity/id";
import type { AggregatePersistence, Repository } from "./repository";

// @ts-expect-error IRepository was removed in favour of the explicit
// AggregatePersistence and Repository contracts.
type RemovedIRepository = import("../index").IRepository;
// @ts-expect-error IUnitOfWorkRepository was removed; repositories now
// participate in the mandatory Unit of Work through the new contracts.
type RemovedIUnitOfWorkRepository = import("../index").IUnitOfWorkRepository;

void (undefined as unknown as RemovedIRepository);
void (undefined as unknown as RemovedIUnitOfWorkRepository);

type RemovedQueryContract = RemovedQueryableRepository<never, never, never>;
const removedQueryContractMustStayAbsent =
	null as unknown as RemovedQueryContract;
void removedQueryContractMustStayAbsent;

type OrderId = Id<"OrderId">;
type Order = IAggregateRoot<OrderId> & {
	readonly customerId: string;
	readonly total: number;
};

describe("IAggregateRoot interface contract", () => {
	it("exposes persistence facts without lifecycle mutation authority", () => {
		const stub: IAggregateRoot<OrderId> = {
			id: "o-1" as OrderId,
			version: 0 as Version,
			pendingEvents: [],
		};

		expect(stub.version).toBe(0);
		expect(stub.pendingEvents).toEqual([]);
	});
});

describe("Repository contract", () => {
	describe("AggregatePersistence: common lifecycle contract", () => {
		it("makes new and loaded write intent explicit", async () => {
			class OrderPersistence implements AggregatePersistence<Order, OrderId> {
				readonly added: Order[] = [];
				readonly updated: Order[] = [];

				async findById(_id: OrderId): Promise<Order | undefined> {
					return undefined;
				}

				async getById(id: OrderId): Promise<Order> {
					throw new AggregateNotFoundError({ aggregateType: "Order", id });
				}

				add(aggregate: Order): void {
					this.added.push(aggregate);
				}

				update(aggregate: Order): void {
					this.updated.push(aggregate);
				}
			}

			const persistence = new OrderPersistence();
			const order: Order = {
				id: "o-1" as OrderId,
				version: 1 as never,
				customerId: "c-1",
				total: 100,
				pendingEvents: [],
			};

			const addResult = persistence.add(order);
			const updateResult = persistence.update(order);

			expect(addResult).toBeUndefined();
			expect(updateResult).toBeUndefined();
			expect(persistence.added).toEqual([order]);
			expect(persistence.updated).toEqual([order]);
			expect(await persistence.findById(order.id)).toBeUndefined();
			await expect(persistence.getById(order.id)).rejects.toBeInstanceOf(
				AggregateNotFoundError,
			);
		});

		it("does not pretend that every persistence strategy supports physical removal", () => {
			type CommonContract = AggregatePersistence<Order, OrderId>;
			// @ts-expect-error physical removal is deliberately not universal
			type RemovedFromCommonContract = CommonContract["remove"];
			// @ts-expect-error exists is a consumer-owned lookup, not a universal law
			type ExistsOnCommonContract = CommonContract["exists"];
			// @ts-expect-error save hid the new-versus-loaded lifecycle decision
			type SaveOnCommonContract = CommonContract["save"];
			// @ts-expect-error delete was replaced by the collection-oriented remove name
			type DeleteOnCommonContract = CommonContract["delete"];

			void (undefined as unknown as RemovedFromCommonContract);
			void (undefined as unknown as ExistsOnCommonContract);
			void (undefined as unknown as SaveOnCommonContract);
			void (undefined as unknown as DeleteOnCommonContract);
		});
	});

	describe("Repository: full collection lifecycle", () => {
		it("does not revive the ambiguous save/delete protocol", () => {
			type FullContract = Repository<Order, OrderId>;
			// @ts-expect-error add/update replace the ambiguous save operation
			type SaveOnFullContract = FullContract["save"];
			// @ts-expect-error physical removal is named remove, not delete
			type DeleteOnFullContract = FullContract["delete"];

			void (undefined as unknown as SaveOnFullContract);
			void (undefined as unknown as DeleteOnFullContract);
		});

		it("adds physical removal to AggregatePersistence", () => {
			class OrderRepository implements Repository<Order, OrderId> {
				readonly removed: Order[] = [];

				async findById(): Promise<Order | undefined> {
					return undefined;
				}

				async getById(id: OrderId): Promise<Order> {
					throw new AggregateNotFoundError({ aggregateType: "Order", id });
				}

				add(): void {}
				update(): void {}

				remove(aggregate: Order): void {
					this.removed.push(aggregate);
				}
			}

			const repository = new OrderRepository();
			const order = {
				id: "o-1" as OrderId,
				version: 1 as never,
				customerId: "c-1",
				total: 100,
				pendingEvents: [],
			};

			const removeResult = repository.remove(order);

			expect(removeResult).toBeUndefined();
			expect(repository.removed).toEqual([order]);
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

		it("is the canonical error a Unit-of-Work flush surfaces on optimistic-lock mismatch", () => {
			const flush = () => {
				throw new ConcurrencyConflictError({
					aggregateType: "Order",
					aggregateId: "o-1",
					expectedVersion: 3,
					actualVersion: 4,
				});
			};

			expect(flush).toThrow(ConcurrencyConflictError);
		});
	});
});
