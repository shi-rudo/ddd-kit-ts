import { describe, expect, it } from "vitest";
import { deepFreeze, ValueObject, vo } from "./value-object";

const mutableBuiltInCases = [
        {
            name: "Date",
            create: () => new Date(1_000),
            read: (value: object) => (value as Date).getTime(),
            expected: 1_000,
            mutate: (value: object) => (value as Date).setTime(0),
        },
        {
            name: "Map",
            create: () => new Map([["key", { value: "initial" }]]),
            read: (value: object) =>
                (value as Map<string, unknown>).get("key"),
            expected: { value: "initial" },
            mutate: (value: object) =>
                (value as Map<string, unknown>).set("other", true),
        },
        {
            name: "Set",
            create: () => new Set([{ value: "initial" }]),
            read: (value: object) => (value as Set<unknown>).size,
            expected: 1,
            mutate: (value: object) => (value as Set<unknown>).add("other"),
        },
    ] as const;

const atomicBuiltInCases = [
    {
        name: "RegExp",
        create: () => /value/,
        read: (value: object) => (value as RegExp).test("value"),
        expected: true,
    },
    {
        name: "ArrayBuffer",
        create: () => new ArrayBuffer(8),
        read: (value: object) => (value as ArrayBuffer).byteLength,
        expected: 8,
    },
    {
        name: "SharedArrayBuffer",
        create: () => new SharedArrayBuffer(8),
        read: (value: object) => (value as SharedArrayBuffer).byteLength,
        expected: 8,
    },
    {
        name: "Number",
        create: () => new Number(7),
        read: (value: object) =>
            (value as { valueOf(): unknown }).valueOf(),
        expected: 7,
    },
    {
        name: "Boolean",
        create: () => new Boolean(true),
        read: (value: object) =>
            (value as { valueOf(): unknown }).valueOf(),
        expected: true,
    },
    {
        name: "String",
        create: () => new String("value"),
        read: (value: object) =>
            (value as { valueOf(): unknown }).valueOf(),
        expected: "value",
    },
    {
        name: "BigInt",
        create: () => Object(7n),
        read: (value: object) => value.valueOf(),
        expected: 7n,
    },
    {
        name: "Error",
        create: () => new Error("value"),
        read: (value: object) => (value as Error).message,
        expected: "value",
    },
] as const;

const forbiddenBuiltInCases = [
    { name: "Promise", create: () => Promise.resolve("value") },
    { name: "WeakMap", create: () => new WeakMap<object, unknown>() },
    { name: "WeakSet", create: () => new WeakSet<object>() },
] as const;

function maskWithOwnDataTag<T extends object>(value: T): T {
    Object.defineProperty(value, Symbol.toStringTag, {
        configurable: true,
        value: "Object",
    });
    return value;
}

function maskWithInheritedDataTag<T extends object>(value: T): T {
    const prototype = Object.create(Object.getPrototypeOf(value));
    Object.defineProperty(prototype, Symbol.toStringTag, { value: "Object" });
    Object.setPrototypeOf(value, prototype);
    return value;
}

describe("deepFreeze", () => {

    it.each(mutableBuiltInCases)(
        "blocks $name mutators with an own toStringTag accessor",
        ({ name, create, mutate }) => {
            const value = create();
            Object.defineProperty(value, Symbol.toStringTag, {
                configurable: true,
                get: () => name,
            });

            deepFreeze(value);

            expect(() => mutate(value)).toThrow(TypeError);
        },
    );

    it.each(mutableBuiltInCases)(
        "blocks $name mutators with an inherited toStringTag accessor",
        ({ name, create, mutate }) => {
            const value = create();
            const prototype = Object.create(Object.getPrototypeOf(value));
            Object.defineProperty(prototype, Symbol.toStringTag, {
                get: () => name,
            });
            Object.setPrototypeOf(value, prototype);

            deepFreeze(value);

            expect(() => mutate(value)).toThrow(TypeError);
        },
    );

    it.each(mutableBuiltInCases)(
        "blocks $name mutators with an own data toStringTag",
        ({ create, mutate }) => {
            const value = create();
            Object.defineProperty(value, Symbol.toStringTag, {
                configurable: true,
                value: "Object",
            });

            deepFreeze(value);

            expect(() => mutate(value)).toThrow(TypeError);
        },
    );

    it.each(mutableBuiltInCases)(
        "blocks $name mutators with an inherited data toStringTag",
        ({ create, mutate }) => {
            const value = create();
            const prototype = Object.create(Object.getPrototypeOf(value));
            Object.defineProperty(prototype, Symbol.toStringTag, {
                value: "Object",
            });
            Object.setPrototypeOf(value, prototype);

            deepFreeze(value);

            expect(() => mutate(value)).toThrow(TypeError);
        },
    );

    it("does not invoke inherited toStringTag accessors", () => {
        let accessorInvoked = false;
        const prototype = Object.create(Object.prototype);
        Object.defineProperty(prototype, Symbol.toStringTag, {
            get: () => {
                accessorInvoked = true;
                return "Object";
            },
        });
        const value = Object.create(prototype) as { nested: { value: string } };
        value.nested = { value: "initial" };

        deepFreeze(value);

        expect(accessorInvoked).toBe(false);
        expect(Object.isFrozen(value)).toBe(true);
        expect(Object.isFrozen(value.nested)).toBe(true);
    });
});

describe("vo built-ins with data toStringTag overrides", () => {
    it.each(mutableBuiltInCases)(
        "preserves $name with an own data toStringTag",
        ({ create, read, expected, mutate }) => {
            const value = create();
            Object.defineProperty(value, Symbol.toStringTag, {
                configurable: true,
                value: "Object",
            });

            const frozen = vo({ value }).value;

            expect(read(frozen)).toEqual(expected);
            expect(() => mutate(frozen)).toThrow(TypeError);
        },
    );

    it.each(mutableBuiltInCases)(
        "preserves $name with an inherited data toStringTag",
        ({ create, read, expected, mutate }) => {
            const value = create();
            const prototype = Object.create(Object.getPrototypeOf(value));
            Object.defineProperty(prototype, Symbol.toStringTag, {
                value: "Object",
            });
            Object.setPrototypeOf(value, prototype);

            const frozen = vo({ value }).value;

            expect(read(frozen)).toEqual(expected);
            expect(() => mutate(frozen)).toThrow(TypeError);
        },
    );

    it.each(atomicBuiltInCases)(
        "preserves $name with an own data toStringTag",
        ({ create, read, expected }) => {
            const frozen = vo({ value: maskWithOwnDataTag(create()) }).value;

            expect(read(frozen)).toEqual(expected);
        },
    );

    it.each(atomicBuiltInCases)(
        "preserves $name with an inherited data toStringTag",
        ({ create, read, expected }) => {
            const frozen = vo({ value: maskWithInheritedDataTag(create()) }).value;

            expect(read(frozen)).toEqual(expected);
        },
    );

    it.each(forbiddenBuiltInCases)(
        "rejects $name with an own data toStringTag",
        ({ create }) => {
            expect(() => vo({ value: maskWithOwnDataTag(create()) })).toThrow(
                /Value Objects are plain data/,
            );
        },
    );

    it.each(forbiddenBuiltInCases)(
        "rejects $name with an inherited data toStringTag",
        ({ create }) => {
            expect(() => vo({ value: maskWithInheritedDataTag(create()) })).toThrow(
                /Value Objects are plain data/,
            );
        },
    );
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

        it("should accept props containing a non-empty TypedArray", () => {
            interface BlobProps {
                data: Uint8Array;
            }

            class Blob extends ValueObject<BlobProps> {
                constructor(props: BlobProps) {
                    super(props);
                }
            }

            const blob = new Blob({ data: new Uint8Array([1, 2, 3]) });
            expect(Array.from(blob.props.data)).toEqual([1, 2, 3]);
            expect(Object.isFrozen(blob.props)).toBe(true);
        });

        it("does not freeze (or shadow) caller-owned objects inside Map/Set props", () => {
            interface BagProps {
                m: Map<string, Date>;
                e: Error;
            }

            class Bag extends ValueObject<BagProps> {}

            const d = new Date(1000);
            const e = new Error("mine");
            const bag = new Bag({ m: new Map([["k", d]]), e });

            // The caller's Date must stay fully usable: no in-place freeze,
            // no permanently installed throwing setTime shadow.
            expect(Object.isFrozen(d)).toBe(false);
            d.setTime(5);
            expect(d.getTime()).toBe(5);
            // The caller's Error must not be frozen or aliased into props.
            expect(Object.isFrozen(e)).toBe(false);
            expect(bag.props.e).not.toBe(e);
            // The VO's own copy is still immutable.
            expect(() => bag.props.m.get("k")?.setTime(99)).toThrow(TypeError);
        });

        it("rejects function-valued props with a descriptive TypeError (aligned with vo())", () => {
            interface FnProps {
                calc: () => number;
            }
            class FnVO extends ValueObject<FnProps> {}

            expect(() => new FnVO({ calc: () => 42 })).toThrow(
                /does not accept function values/,
            );
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
            // ...and later mutation must not bleed into the VO.
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
});
