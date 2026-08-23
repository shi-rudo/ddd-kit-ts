import { describe, expectTypeOf, it } from "vite-plus/test";
import type { UntypedMapDispatch } from "./bus-internals";

describe("UntypedMapDispatch", () => {
	it("allows manual result typing only for the default untyped map", () => {
		type Message = { readonly type: "Example" };
		type AnyMap = ReturnType<typeof JSON.parse>;

		expectTypeOf<
			UntypedMapDispatch<Record<string, unknown>, Message>
		>().toEqualTypeOf<Message>();
		expectTypeOf<
			UntypedMapDispatch<{ Example: string }, Message>
		>().toEqualTypeOf<never>();
		expectTypeOf<
			UntypedMapDispatch<Record<string, string>, Message>
		>().toEqualTypeOf<never>();
		expectTypeOf<
			UntypedMapDispatch<Record<string, unknown> & { Example: string }, Message>
		>().toEqualTypeOf<never>();
		expectTypeOf<UntypedMapDispatch<AnyMap, Message>>().toEqualTypeOf<never>();
	});
});
