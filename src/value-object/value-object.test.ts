import { describe, expect, it } from "vitest";
import { ValueObject } from "./value-object";

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
