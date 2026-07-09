# Money

Money is one of the places where "close enough" becomes a production bug.
The kit therefore treats money as an exact domain value:

```ts
import { moneyOfMinor } from "@shirudo/ddd-kit/money";

const price = moneyOfMinor(1099n, "EUR", 2);
// { amountMinor: 1099n, currency: "EUR", scale: 2 }
```

Read that shape literally:

- `amountMinor` is a `bigint` in the value's minor units.
- `currency` is part of the value. `10 EUR` and `10 USD` are different.
- `scale` is part of the value. `1099n` at scale `2` means `10.99`; at
  scale `3` it means `1.099`.

The rule for application code is simple: parse money at the edge, keep
`Money` inside the domain, store integer minor units, and convert to DTOs
only at JSON boundaries.

| Place | Shape |
| --- | --- |
| HTML form, API input | Decimal string, parsed with `parseMoneyInput` or a `MoneyFactory` |
| Aggregate state | `Money` |
| Domain event payloads | `Money` |
| Database columns | `amount_minor`, `currency`, `scale` |
| JSON response or event-store JSON | `MoneyDto` with `amountMinor` as a string |
| Calculation library | Snapshot bridge via `moneyToSnapshot` and `moneyFromSnapshot` |

Do not pass floats around and do not hide the scale in a field name. If
the scale matters, make it data.

## The Contract

`Money` is plain frozen data. It has no methods, no library internals, and
no hidden runtime brand. That is deliberate: aggregate state, event
payloads, snapshots, and deep-freeze checks can all handle it without
special cases.

```ts
import {
  moneyFromDto,
  moneyFromUnknown,
  moneyOfMinor,
  moneyToDto,
} from "@shirudo/ddd-kit/money";

const fromCode = moneyOfMinor(1099n, "EUR", 2);

const fromWire = moneyFromDto({
  amountMinor: "1099",
  currency: "EUR",
  scale: 2,
});

const fromPlainObject = moneyFromUnknown({
  amountMinor: 1099n,
  currency: "EUR",
  scale: 2,
});

const dto = moneyToDto(fromCode);
// { amountMinor: "1099", currency: "EUR", scale: 2 }
```

Use the constructors as the door into the type:

- `moneyOfMinor` is for trusted code that already has a `bigint`.
- `moneyFromDto` is for JSON-safe wire data where the amount is a string.
- `moneyFromUnknown` is for foreign plain objects that already contain a
  `bigint` amount.
- `isMoney` is only a check. It does not copy or freeze the value, so it is
  not the right boundary for domain state.

Construction also applies hard bounds. Amounts stay below 97 digits, scale
is between `0` and `64`, and currency is a non-empty string without
whitespace. That is not business validation; it is input safety. A
multi-megabyte amount string should fail before it can buy CPU, memory, or
log space.

## Parsing User Input

Never turn user input into a number first. This is the bug:

```ts
const minor = Number(req.body.amount) * 100;
```

It accepts values you did not mean to accept, loses precision, and puts a
rounding decision in the wrong place.

Use exact parsing instead:

```ts
import { parseMoneyInput } from "@shirudo/ddd-kit/money";

parseMoneyInput("10.99", { currency: "EUR", scale: 2 });  // 1099n
parseMoneyInput("10", { currency: "JPY", scale: 0 });     // 10n
parseMoneyInput("10.5", { currency: "EUR", scale: 2 });   // 1050n
parseMoneyInput("10.990", { currency: "EUR", scale: 2 }); // 1099n

parseMoneyInput("10.999", { currency: "EUR", scale: 2 });
// throws MONEY_PRECISION_LOSS
```

The parser accepts a plain decimal string matching `/^-?\d+(\.\d+)?$/`.
It does not accept exponents, `Infinity`, currency symbols, grouping
separators, or locale decimals such as `"10,99"`. Normalize UI text before
calling it.

The important part is the failure behavior: parsing is exact or rejected.
If your product wants to accept `"10.999"` and round it to `"11.00"`, that
is a business rule. Name it and put it somewhere reviewable:

```ts
function normalizeSupplierPrice(raw: unknown): Money {
  const quoted = parseMoneyInput(raw, { currency: "EUR", scale: 4 });
  return roundSupplierPrice(quoted);
}
```

`roundSupplierPrice` can use a calculation library. The point is that the
policy has a name. Nobody reviewing this code has to guess whether parser
rounding is tax policy, supplier policy, display cleanup, or a mistake.

## Currency Scales

The kit does not ship a currency table. That is intentional. Different
systems have different accepted currencies, custom tokens, historical
requirements, and release processes for currency metadata.

For one-off construction, pass the scale explicitly:

```ts
const eur = moneyOfMinor(1099n, "EUR", 2);
const jpy = moneyOfMinor(1099n, "JPY", 0);
```

For application code, wire a factory once at the composition root:

```ts
import {
  createMoneyFactory,
  currencyScaleFromIntl,
  currencyScaleFromRecord,
} from "@shirudo/ddd-kit/money";

export const money = createMoneyFactory({
  scaleFor: currencyScaleFromRecord({
    EUR: 2,
    USD: 2,
    JPY: 0,
  }),
});

money.parse("10.99", "EUR");
money.ofMinor(1099n, "EUR");
money.zero("JPY");
money.scaleOf("USD");
```

That factory turns an unknown currency into `UNKNOWN_CURRENCY` instead of
guessing.

`currencyScaleFromRecord` is the normal production choice when you want a
closed, auditable set. You can also source the scale from a calculation
library's currency package:

```ts
import * as currencies from "@dinero.js/currencies";
import type { Currency } from "dinero.js";
import { createMoneyFactory } from "@shirudo/ddd-kit/money";

const money = createMoneyFactory({
  scaleFor: (code) =>
    (currencies as Record<string, Currency<number>>)[code]?.exponent,
});
```

`currencyScaleFromIntl()` is useful for demos and internal tools:

```ts
const demoMoney = createMoneyFactory({
  scaleFor: currencyScaleFromIntl(),
});
```

Do not treat it as an enterprise source of truth. It only resolves
canonical uppercase ISO-style codes, well-formed but unassigned codes can
fall back to a default scale in ICU, and the data follows the runtime's ICU
version. Pin your production set if money correctness matters.

## Exact Arithmetic

The kit includes only operations that cannot lose information:

```ts
import {
  addMoney,
  negateMoney,
  rescaleMoney,
  subtractMoney,
} from "@shirudo/ddd-kit/money";

const a = moneyOfMinor(1099n, "EUR", 2);
const b = moneyOfMinor(901n, "EUR", 2);

addMoney(a, b);        // 2000n EUR scale 2
subtractMoney(a, b);   // 198n EUR scale 2
negateMoney(a);        // -1099n EUR scale 2
rescaleMoney(a, 3);    // 10990n EUR scale 3
```

`addMoney` and `subtractMoney` require the same currency and the same
scale. Mismatches throw `MONEY_CURRENCY_MISMATCH` or
`MONEY_SCALE_MISMATCH`. The kit does not silently convert either side.

`rescaleMoney` is also exact. Upscaling works. Downscaling works only when
the removed digits are zero:

```ts
rescaleMoney(moneyOfMinor(10990n, "EUR", 3), 2); // 1099n
rescaleMoney(moneyOfMinor(10999n, "EUR", 3), 2); // MONEY_PRECISION_LOSS
```

There is deliberately no rounding parameter. Rounding is not mechanical
plumbing in a money system. It is policy.

## Rounding, Allocation, Fees, And FX

This is the line between the kit and your domain:

- The kit owns the exact contract and lossless operations.
- Your domain owns policy names such as `calculateVat`, `allocateRefund`,
  `applyCardFee`, or `convertAtBookedRate`.
- A calculation library executes the math behind those policy names.

For example, summing already aligned invoice lines is safe in an aggregate:

```ts
const nextTotal = addMoney(this.state.total, lineAmount);
```

Calculating VAT is different. You need to know whether to round per line or
per invoice, which rounding mode applies, and whether the price is net or
gross. That rule belongs in application code or a domain service with a
business name:

```ts
function calculateVat(net: Money, policy: VatPolicy): Money {
  const calculatorMoney = dinero(moneyToSnapshot(net));
  const vat = applyVatPolicy(calculatorMoney, policy);
  return moneyFromSnapshot(toSnapshot(vat));
}
```

The exact library does not matter to the kit. The boundary shape does.

## Calculation Library Bridge

`moneyToSnapshot` and `moneyFromSnapshot` use the structural shape common
to money calculation libraries:

```ts
import { add, dinero, toSnapshot } from "dinero.js";
import {
  moneyFromSnapshot,
  moneyOfMinor,
  moneyToSnapshot,
} from "@shirudo/ddd-kit/money";

const first = dinero(moneyToSnapshot(moneyOfMinor(1099n, "EUR", 2)));
const second = dinero(moneyToSnapshot(moneyOfMinor(901n, "EUR", 2)));

const sum = moneyFromSnapshot(toSnapshot(add(first, second)));
```

The bridge is an anti-corruption layer:

- non-decimal currency bases are rejected, because they do not map to a
  power-of-ten scale;
- number amounts must be safe integers;
- bigint snapshots are accepted exactly.

`moneyToSnapshot` emits number-based snapshots because that is what many
default calculators use. If an amount is past `Number.MAX_SAFE_INTEGER`, it
throws instead of corrupting the value. In that case, build the library
object with its bigint calculator directly from `money.amountMinor`:

```ts
import { calculator } from "@dinero.js/calculator-bigint";
import { createDinero, toSnapshot } from "dinero.js";

const dineroBigint = createDinero({ calculator });
const EUR = { code: "EUR", base: 10n, exponent: 2n };

const value = dineroBigint({
  amount: money.amountMinor,
  currency: EUR,
  scale: BigInt(money.scale),
});

const back = moneyFromSnapshot(toSnapshot(value));
```

Keep library objects inside the use case. Store `Money` in aggregates,
events, snapshots, and persistence models.

## Wire And Persistence

JSON cannot carry `bigint`, and JSON numbers are floating point. Money
therefore uses `MoneyDto` on JSON boundaries:

```json
{ "amountMinor": "1099", "currency": "EUR", "scale": 2 }
```

Convert immediately after deserialization and immediately before
serialization:

```ts
const amount = moneyFromDto(req.body.amount);

res.json({
  total: moneyToDto(invoice.total),
});
```

For a relational database, store the same three pieces separately:

```sql
create table invoice (
  id text primary key,
  version integer not null,
  total_minor bigint not null,
  total_currency char(3) not null,
  total_scale smallint not null check (total_scale between 0 and 64)
);
```

Use `bigint` for ordinary fiat systems. A signed SQL `bigint` gives you
about 9.2e18 minor units, which is far beyond normal business balances.
The domain type allows larger values because some domains need token-like
amounts. If your domain really needs that headroom, use `numeric(96, 0)`
for the minor amount and make the range explicit in the schema.

Drivers differ. `node-postgres` returns SQL `bigint` as a string, which
maps naturally through `moneyFromDto`. An ORM that returns native `bigint`
can call `moneyOfMinor` directly.

```ts
import { moneyFromDto, moneyOfMinor, type Money } from "@shirudo/ddd-kit/money";

function moneyFromPgColumns(
  amountMinor: string,
  currency: string,
  scale: number,
): Money {
  return moneyFromDto({ amountMinor, currency, scale });
}

function moneyFromNativeColumns(
  amountMinor: bigint,
  currency: string,
  scale: number,
): Money {
  return moneyOfMinor(amountMinor, currency, scale);
}
```

If an event store serializes payloads as JSON, the adapter should convert
money values to `MoneyDto` in the stored JSON and convert them back when
loading. Do that in the adapter, not inside the aggregate.

## A Small Invoice Slice

This example shows the same money value crossing the boundary, domain, and
repository. The important part is not the invoice model; it is where each
shape appears.

```ts
import {
  AggregateRoot,
  DomainError,
  type DomainEvent,
  type Id,
  type Version,
} from "@shirudo/ddd-kit";
import {
  addMoney,
  isNegativeMoney,
  moneyToDto,
  type Money,
} from "@shirudo/ddd-kit/money";

type InvoiceId = Id<"InvoiceId">;

type InvoiceState = {
  customerId: string;
  lines: ReadonlyArray<{ sku: string; amount: Money }>;
  total: Money;
  status: "open" | "issued";
};

type InvoiceIssued = DomainEvent<
  "InvoiceIssued",
  { invoiceId: InvoiceId; total: Money }
>;

type InvoiceEvent = InvoiceIssued;

class InvoiceLineRejectedError extends DomainError<"INVOICE_LINE_REJECTED"> {
  constructor(message: string) {
    super({ code: "INVOICE_LINE_REJECTED", message });
  }
}

class Invoice extends AggregateRoot<InvoiceState, InvoiceId, InvoiceEvent> {
  protected readonly aggregateType = "Invoice";

  static open(id: InvoiceId, customerId: string, zero: Money): Invoice {
    return new Invoice(id, {
      customerId,
      lines: [],
      total: zero,
      status: "open",
    });
  }

  static reconstitute(
    id: InvoiceId,
    state: InvoiceState,
    version: Version,
  ): Invoice {
    const invoice = new Invoice(id, state);
    invoice.markRestored(version);
    return invoice;
  }

  addLine(sku: string, amount: Money): void {
    if (this.state.status !== "open") {
      throw new InvoiceLineRejectedError("invoice is already issued");
    }
    if (isNegativeMoney(amount)) {
      throw new InvoiceLineRejectedError("line amount must not be negative");
    }

    this.setState({
      ...this.state,
      lines: [...this.state.lines, { sku, amount }],
      total: addMoney(this.state.total, amount),
    });
  }

  issue(): void {
    this.commit(
      { ...this.state, status: "issued" },
      this.recordEvent("InvoiceIssued", {
        invoiceId: this.id,
        total: this.state.total,
      }),
    );
  }

  get total(): Money {
    return this.state.total;
  }
}
```

The aggregate stores `Money`, not calculation-library objects. It uses
`addMoney` because summing same-currency, same-scale line values is
lossless. It records `Money` in the domain event too.

The repository maps database columns at the adapter boundary:

```ts
class PgInvoiceRepository {
  constructor(private readonly tx: PgTx) {}

  async getById(id: InvoiceId): Promise<Invoice> {
    const row = await this.tx.one("select * from invoice where id = $1", [id]);
    const lines = await this.tx.many(
      "select * from invoice_line where invoice_id = $1 order by position",
      [id],
    );

    return Invoice.reconstitute(
      id,
      {
        customerId: row.customer_id,
        lines: lines.map((line) => ({
          sku: line.sku,
          amount: moneyFromPgColumns(
            line.amount_minor,
            line.amount_currency,
            line.amount_scale,
          ),
        })),
        total: moneyFromPgColumns(
          row.total_minor,
          row.total_currency,
          row.total_scale,
        ),
        status: row.status,
      },
      row.version,
    );
  }

  async save(invoice: Invoice): Promise<void> {
    const { total } = invoice.state;

    await this.tx.query(
      `update invoice
          set version = $2,
              status = $3,
              total_minor = $4,
              total_currency = $5,
              total_scale = $6
        where id = $1 and version = $7`,
      [
        invoice.id,
        invoice.version,
        invoice.state.status,
        total.amountMinor.toString(),
        total.currency,
        total.scale,
        invoice.persistedVersion,
      ],
    );
  }
}
```

The HTTP entry point parses raw input once and emits DTOs once:

```ts
app.post("/invoices/:id/lines", async (req, res) => {
  const amount = money.parse(req.body.amount, "EUR");

  const total = await withCommit({ scope, outbox, bus }, async (tx) => {
    const invoices = new PgInvoiceRepository(tx);
    const invoice = await invoices.getById(asInvoiceId(req.params.id));

    invoice.addLine(String(req.body.sku), amount);
    await invoices.save(invoice);

    return { result: invoice.total, aggregates: [invoice] };
  });

  res.status(200).json({ total: moneyToDto(total) });
});
```

Notice the direction:

1. Raw string enters at the edge.
2. `Money` lives inside the use case and aggregate.
3. Repository writes integer minor units, currency, and scale.
4. JSON response uses `MoneyDto`.

That discipline keeps parsing, persistence, and domain invariants from
leaking into each other.

## Formatting

Formatting is presentation, not parsing and not arithmetic:

```ts
import {
  createMoneyFormatter,
  formatMoney,
  moneyOfMinor,
} from "@shirudo/ddd-kit/money";

formatMoney(moneyOfMinor(1099n, "EUR", 2), "de-DE");
// "10,99 €"

const format = createMoneyFormatter("en-US");
format(moneyOfMinor(9007199254740993n, "USD", 2));
// "$90,071,992,547,409.93"
```

`formatMoney` feeds `Intl.NumberFormat` an exact decimal string, not a
float. Use `createMoneyFormatter` in hot paths such as tables and exports;
it caches one formatter per currency and scale.

Do not parse formatted output. Locale output is text for humans.

## Common Mistakes

**Using `number` because the UI sends a number**

Reject it. A JSON number is already the wrong shape for money input. Accept
a decimal string and parse it exactly.

```ts
money.parse(req.body.amount, "EUR");
```

**Assuming every currency has scale 2**

The scale belongs to the value. JPY, KWD, custom token units, and
intermediate calculation precision all exist. Wire a `MoneyFactory` instead
of hard-coding a global default.

**Rounding in the parser**

Parsing answers one question: can this string be represented exactly at
this scale? If the answer is no, a domain policy must decide what happens
next.

**Putting calculation-library objects in aggregate state**

Those objects usually carry methods and internal fields. They are fine
inside a use case. They are the wrong persistence and event contract.
Bridge them back to `Money` before storing state or recording events.

**Using `moneyToSnapshot` for huge values**

`moneyToSnapshot` is number-based and rejects values past
`Number.MAX_SAFE_INTEGER`. That is good. For huge values, use your
calculation library's bigint calculator and pass `money.amountMinor`
directly.

**Letting display text flow back into the system**

`"10,99 €"` is not input for `parseMoneyInput`. It is presentation output.
Normalize UI text into a plain decimal string first.

## Errors

Money errors are `DomainError`s and are registered by
`createKitPublicErrors()` as client-safe 422 responses.

| Code | Raised when |
| --- | --- |
| `INVALID_MONEY` | malformed values, DTOs, inputs, snapshots, invalid bounds |
| `MONEY_CURRENCY_MISMATCH` | adding or subtracting different currencies |
| `MONEY_SCALE_MISMATCH` | adding or subtracting different scales |
| `MONEY_PRECISION_LOSS` | exact parse or exact rescale would lose non-zero digits |
| `UNKNOWN_CURRENCY` | a `MoneyFactory` resolver has no scale for the currency |

Treat these as validation and domain errors. Do not retry them.

## FX

Currency conversion is not just multiplication by a rate. A booked
conversion needs the source amount, target amount, rate, source, timestamp,
and rounding mode:

```ts
type FxConversion = {
  source: Money;
  target: Money;
  rate: string;
  rateSource: string;
  resolvedAt: Date;
  roundingMode: string;
};
```

Persist that record. Do not recompute historical conversions from a newer
rate. The kit deliberately ships no FX helper because rate resolution,
rounding, and audit policy belong to your application.
