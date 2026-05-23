import { describe, expectTypeOf, it } from "vitest";
import type { Id, IdGenerator } from "./id";

type UserId = Id<"UserId">;
type OrderId = Id<"OrderId">;

describe("Id<Tag> brand", () => {
	it("structurally typed as string but tagged via __brand", () => {
		const u = "user-1" as UserId;
		expectTypeOf<UserId>().toEqualTypeOf<string & { readonly __brand: "UserId" }>();
		// A bare string is not assignable to a branded UserId:
		// @ts-expect-error: plain string lacks the brand
		const _bad: UserId = "not-branded";
		void _bad;
		void u;
	});

	it("brands of different tags are not interchangeable", () => {
		const u = "u-1" as UserId;
		// @ts-expect-error: OrderId and UserId carry incompatible brands
		const _o: OrderId = u;
		void _o;
	});
});

describe("IdGenerator<Tag> brand binding", () => {
	it("binds the tag at the generator type, not at the call site", () => {
		const userGen: IdGenerator<"UserId"> = { next: () => "u-1" as UserId };

		const id: UserId = userGen.next();
		expectTypeOf(id).toEqualTypeOf<UserId>();
		void id;
	});

	it("rejects assigning a UserId generator where an OrderId generator is expected", () => {
		const userGen: IdGenerator<"UserId"> = { next: () => "u-1" as UserId };
		// @ts-expect-error: the tag parameter is invariant — UserId generator ≠ OrderId generator
		const _orderGen: IdGenerator<"OrderId"> = userGen;
		void _orderGen;
	});

	it("does not let callers steal an unrelated brand at the call site", () => {
		const userGen: IdGenerator<"UserId"> = { next: () => "u-1" as UserId };
		// next() is just () => Id<"UserId"> now — no caller-picked generic to abuse.
		const value = userGen.next();
		// Assigning to OrderId would require an explicit cast — the type system
		// no longer hands out wrong-tagged ids for free.
		// @ts-expect-error: Id<"UserId"> is not assignable to Id<"OrderId">
		const _orderId: OrderId = value;
		void _orderId;
	});
});
