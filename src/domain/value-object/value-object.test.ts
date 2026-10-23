import { describe, expect, it } from "vite-plus/test";
import { deepFreeze, ValueObject } from "./value-object";

describe("deepFreeze", () => {
	it("does not walk a subtree it already deep-froze", () => {
		let reads = 0;
		const child = Object.defineProperty({}, "leaf", {
			enumerable: true,
			get: () => {
				reads += 1;
				return { value: 1 };
			},
		});
		deepFreeze(child);
		const readsAfterFirstFreeze = reads;

		deepFreeze({ ...{}, child });

		expect(readsAfterFirstFreeze).toBe(1);
		expect(reads).toBe(readsAfterFirstFreeze);
	});

	it("memoizes a sibling subtree although a caller-frozen Date keeps its own subtree open", () => {
		let reads = 0;
		const lines = Object.defineProperty({}, "leaf", {
			enumerable: true,
			get: () => {
				reads += 1;
				return { value: 1 };
			},
		});
		// A Date frozen by the caller takes no mutator shadows and stays
		// mutable through setTime, so the object that holds it is walked
		// again; the sibling subtree is not.
		const state = { calendar: Object.freeze(new Date(0)), lines };
		deepFreeze(state);
		const readsAfterFirstFreeze = reads;

		deepFreeze({ ...state });
		deepFreeze({ ...state });

		expect(readsAfterFirstFreeze).toBe(1);
		expect(reads).toBe(1);
	});

	it("memoizes a graph that references one object twice", () => {
		let reads = 0;
		const lines = Object.defineProperty({}, "leaf", {
			enumerable: true,
			get: () => {
				reads += 1;
				return { value: 1 };
			},
		});
		const address = { city: "Berlin" };
		// Two edges to one object are not a cycle; the memo must hold.
		const state = { billing: address, shipping: address, lines };
		deepFreeze(state);
		const readsAfterFirstFreeze = reads;

		deepFreeze({ ...state });

		expect(readsAfterFirstFreeze).toBe(1);
		expect(reads).toBe(1);
	});

	it("memoizes a graph that references one RegExp twice", () => {
		let reads = 0;
		const lines = Object.defineProperty({}, "leaf", {
			enumerable: true,
			get: () => {
				reads += 1;
				return { value: 1 };
			},
		});
		const skuPattern = /sku-\d+/;
		// A RegExp passes through the freeze; two edges to it are not a cycle.
		const state = { skuPattern, fallbackPattern: skuPattern, lines };
		deepFreeze(state);
		const readsAfterFirstFreeze = reads;

		deepFreeze({ ...state });

		expect(readsAfterFirstFreeze).toBe(1);
		expect(reads).toBe(1);
	});

	it("freezes a value object instance in place", () => {
		class Money extends ValueObject<{ amount: number }> {
			readonly tags: string[] = [];
		}
		const money = new Money({ amount: 1 });
		const state = { money };

		deepFreeze(state);

		expect(Object.isFrozen(state)).toBe(true);
		expect(Object.isFrozen(money)).toBe(true);
		expect(Object.isFrozen(money.tags)).toBe(true);
	});

	it("still walks a subtree that another freeze left shallow", () => {
		const grandchild = { value: 1 };
		const child = Object.freeze({ grandchild });

		deepFreeze({ child });

		expect(Object.isFrozen(grandchild)).toBe(true);
	});

	it.each([
		["global", /a/g],
		["sticky", /a/y],
	])("keeps a %s RegExp matching after the freeze", (_flag, pattern) => {
		const state = deepFreeze({ pattern });

		expect(state.pattern.test("a")).toBe(true);
		expect(Object.isFrozen(state)).toBe(true);
	});
});

describe("ValueObject Class", () => {
	interface MoneyProps {
		amount: number;
		currency: string;
	}

	class Money extends ValueObject<MoneyProps> {
		constructor(props: MoneyProps) {
			super(props);
		}

		get amount(): number {
			return this.props.amount;
		}

		get currency(): string {
			return this.props.currency;
		}
	}

	interface AddressProps {
		street: string;
		city: string;
		zip: string;
	}

	class Address extends ValueObject<AddressProps> {
		constructor(props: AddressProps) {
			super(props);
		}
	}

	describe("constructor", () => {
		it("should create a value object with properties", () => {
			const money = new Money({ amount: 100, currency: "USD" });
			expect(money.props).toEqual({ amount: 100, currency: "USD" });
			expect(money.amount).toBe(100);
			expect(money.currency).toBe("USD");
		});

		it("should make properties immutable", () => {
			const money = new Money({ amount: 100, currency: "USD" });
			expect(() => {
				(money.props as any).amount = 200;
			}).toThrow();
		});

		it("rejects mutable or reference-compared built-ins in class-based Value Objects", () => {
			interface BlobProps {
				data: object;
			}

			class Blob extends ValueObject<BlobProps> {
				constructor(props: BlobProps) {
					super(props);
				}
			}

			for (const data of [
				new Uint8Array([1, 2, 3]),
				new DataView(new ArrayBuffer(4)),
				new ArrayBuffer(4),
				new SharedArrayBuffer(4),
				new Error("failure"),
			]) {
				expect(() => new Blob({ data })).toThrow(/is binary data|is an Error/);
			}
		});

		it("does not freeze (or shadow) caller-owned objects inside Map/Set props", () => {
			interface BagProps {
				m: Map<string, Date>;
			}

			class Bag extends ValueObject<BagProps> {}

			const d = new Date(1000);
			const bag = new Bag({ m: new Map([["k", d]]) });

			// The caller's Date must stay fully usable: no in-place freeze,
			// no permanently installed throwing setTime shadow.
			expect(Object.isFrozen(d)).toBe(false);
			d.setTime(5);
			expect(d.getTime()).toBe(5);
			// The value object's own copy is still immutable.
			expect(() => bag.props.m.get("k")?.setTime(99)).toThrow(TypeError);
		});

		it("rejects function-valued props with a descriptive TypeError (aligned with valueObject())", () => {
			interface FnProps {
				calc: () => number;
			}
			class FnVO extends ValueObject<FnProps> {}

			expect(() => new FnVO({ calc: () => 42 })).toThrow(/is a function/);
		});

		it("rejects custom class instances in props instead of creating incomplete clones", () => {
			class PrivateValue {
				#value = 5;
				read(): number {
					return this.#value;
				}
			}
			class PrivateValueObject extends ValueObject<{
				value: PrivateValue;
			}> {}

			expect(
				() => new PrivateValueObject({ value: new PrivateValue() }),
			).toThrow(/is a class instance/);
		});

		it("does not freeze the caller's props object or nested objects", () => {
			interface TaggedProps {
				amount: number;
				meta: { tag: string };
			}

			class Tagged extends ValueObject<TaggedProps> {}

			const meta = { tag: "a" };
			const props: TaggedProps = { amount: 100, meta };
			const v = new Tagged(props);

			// The caller's graph must stay mutable...
			expect(Object.isFrozen(props)).toBe(false);
			expect(Object.isFrozen(meta)).toBe(false);
			meta.tag = "changed";
			// ...and later mutation must not bleed into the value object.
			expect(v.props.meta.tag).toBe("a");
		});

		it("should deeply freeze nested properties", () => {
			interface NestedProps {
				nested: {
					value: string;
				};
			}

			class NestedVO extends ValueObject<NestedProps> {
				constructor(props: NestedProps) {
					super(props);
				}
			}

			const nested = new NestedVO({ nested: { value: "test" } });
			expect(() => {
				(nested.props.nested as any).value = "changed";
			}).toThrow();
		});
	});

	describe("equals", () => {
		it("should return true for equal value objects", () => {
			const money1 = new Money({ amount: 100, currency: "USD" });
			const money2 = new Money({ amount: 100, currency: "USD" });
			expect(money1.equals(money2)).toBe(true);
		});

		it("should return false for unequal value objects", () => {
			const money1 = new Money({ amount: 100, currency: "USD" });
			const money2 = new Money({ amount: 200, currency: "USD" });
			expect(money1.equals(money2)).toBe(false);
		});

		it("should return false for equality check between different class instances with same props", () => {
			class AnotherMoney extends ValueObject<MoneyProps> {
				constructor(props: MoneyProps) {
					super(props);
				}
			}
			const m1 = new Money({ amount: 100, currency: "USD" });
			const m2 = new AnotherMoney({ amount: 100, currency: "USD" });

			expect(m1.equals(m2)).toBe(false);
		});
	});

	describe("validate", () => {
		class ValidatedMoney extends ValueObject<MoneyProps> {
			constructor(props: MoneyProps) {
				super(props);
			}

			protected validate(props: MoneyProps): void {
				if (props.amount < 0) {
					throw new Error("Amount cannot be negative");
				}
			}
		}

		it("should throw error when validation fails", () => {
			expect(() => {
				new ValidatedMoney({ amount: -100, currency: "USD" });
			}).toThrow("Amount cannot be negative");
		});

		it("should create instance when validation passes", () => {
			const money = new ValidatedMoney({ amount: 100, currency: "USD" });
			expect(money.props.amount).toBe(100);
		});
	});

	describe("clone", () => {
		it("should create a copy with same properties", () => {
			const money = new Money({ amount: 100, currency: "USD" });
			const cloned = money.clone();

			expect(cloned.equals(money)).toBe(true);
			expect(cloned).not.toBe(money); // Different reference
		});

		it("should create a copy with modified properties", () => {
			const money = new Money({ amount: 100, currency: "USD" });
			const cloned = money.clone({ amount: 200 });

			expect(cloned.props.amount).toBe(200);
			expect(cloned.props.currency).toBe("USD");
			expect(cloned.equals(money)).toBe(false);
		});
	});

	describe("toJSON", () => {
		it("should serialize to plain object props", () => {
			const money = new Money({ amount: 100, currency: "USD" });
			const json = JSON.stringify(money);
			expect(json).toBe('{"amount":100,"currency":"USD"}');
		});
	});

	describe("nested value objects", () => {
		interface PriceProps {
			amount: Money;
			label: string;
		}

		class Price extends ValueObject<PriceProps> {}

		class ForeignMoney extends ValueObject<MoneyProps> {}

		it("keeps a nested value object by reference instead of cloning it", () => {
			const money = new Money({ amount: 100, currency: "USD" });

			const price = new Price({ amount: money, label: "list" });

			expect(price.props.amount).toBe(money);
			expect(price.props.amount.amount).toBe(100);
		});

		it("compares nested value objects by props", () => {
			const first = new Price({
				amount: new Money({ amount: 100, currency: "USD" }),
				label: "list",
			});
			const same = new Price({
				amount: new Money({ amount: 100, currency: "USD" }),
				label: "list",
			});
			const other = new Price({
				amount: new Money({ amount: 200, currency: "USD" }),
				label: "list",
			});

			expect(first.equals(same)).toBe(true);
			expect(first.equals(other)).toBe(false);
		});

		it("treats nested value objects of different classes as unequal", () => {
			const usd = new Price({
				amount: new Money({ amount: 100, currency: "USD" }),
				label: "list",
			});
			const foreign = new Price({
				amount: new ForeignMoney({ amount: 100, currency: "USD" }),
				label: "list",
			} as unknown as PriceProps);

			expect(usd.equals(foreign)).toBe(false);
		});

		it("freezes the nested value object instance in place", () => {
			const money = new Money({ amount: 100, currency: "USD" });

			new Price({ amount: money, label: "list" });

			expect(Object.isFrozen(money)).toBe(true);
		});

		it("rejects a nested value object with own fields outside props", () => {
			class CachedMoney extends ValueObject<MoneyProps> {
				private cache?: string;
				readonly tags: string[] = [];
				get label(): string {
					this.cache ??= `${this.props.amount} ${this.props.currency}`;
					return this.cache;
				}
			}
			const money = new CachedMoney({ amount: 100, currency: "USD" });

			expect(
				() =>
					new Price({ amount: money, label: "list" } as unknown as PriceProps),
			).toThrow(
				"valueObject() cannot nest a value object with own fields outside props (cache, tags): keep the state of a value object in props",
			);
		});

		it("compares a nested value object by its own fields, not through its equals method", () => {
			class LooseMoney extends ValueObject<MoneyProps> {
				override equals(): boolean {
					return true;
				}
			}
			const usd = new Price({
				amount: new LooseMoney({ amount: 100, currency: "USD" }),
				label: "list",
			} as unknown as PriceProps);
			const eur = new Price({
				amount: new LooseMoney({ amount: 100, currency: "EUR" }),
				label: "list",
			} as unknown as PriceProps);

			expect(usd.equals(eur)).toBe(false);
		});

		it("rejects a value object as the root props", () => {
			const money = new Money({ amount: 100, currency: "USD" });
			class Wrapper extends ValueObject<Money> {}

			expect(() => new Wrapper(money)).toThrow(
				"new ValueObject() does not accept a value object as its input: nest the value object under a key, or pass its props",
			);
		});

		it("clones the outer value object and shares the nested one", () => {
			const money = new Money({ amount: 100, currency: "USD" });
			const price = new Price({ amount: money, label: "list" });

			const cloned = price.clone({ label: "sale" });

			expect(cloned.props.amount).toBe(money);
			expect(cloned.props.label).toBe("sale");
			expect(cloned.clone().equals(cloned)).toBe(true);
		});

		it("serializes nested value objects through their props", () => {
			const price = new Price({
				amount: new Money({ amount: 100, currency: "USD" }),
				label: "list",
			});

			expect(JSON.stringify(price)).toBe(
				'{"amount":{"amount":100,"currency":"USD"},"label":"list"}',
			);
		});

		it("rejects a class with a props field that no value object built", () => {
			class Component {
				props = { amount: 100 };
			}

			expect(
				() =>
					new Price({
						amount: new Component(),
						label: "list",
					} as unknown as PriceProps),
			).toThrow(
				"new ValueObject(): props.amount is a class instance (Component); map it to plain data",
			);
		});

		it("rejects a RegExp in the props, because compile() could still change it", () => {
			class Rule extends ValueObject<{ pattern: RegExp }> {}

			expect(() => new Rule({ pattern: /^[a-z]+$/ })).toThrow(
				"new ValueObject(): props.pattern is a RegExp; keep its source and flags as strings",
			);
		});

		it("still rejects a class instance that is not a value object", () => {
			class Tag {
				constructor(readonly name: string) {}
			}

			expect(
				() =>
					new Price({
						amount: new Tag("x"),
						label: "list",
					} as unknown as PriceProps),
			).toThrow(/is a class instance/);
		});
	});
});
