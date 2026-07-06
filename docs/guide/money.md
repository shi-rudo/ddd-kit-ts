# Money

Money must be exact. Floating-point numbers are not: `0.1 + 0.2` is
`0.30000000000000004`, and a JSON number silently loses integer precision
past 2^53. The `@shirudo/ddd-kit/money` entry point ships the canonical
money **contract** and its **boundaries**, so every consumer stops
re-inventing (and mis-inventing) the same shape:

```ts
import { moneyOfMinor } from "@shirudo/ddd-kit/money";

const price = moneyOfMinor(1099n, "EUR", 2);
// { amountMinor: 1099n, currency: "EUR", scale: 2 } and frozen
```

- `amountMinor` is a `bigint` in minor units. Never a `number`, never a
  decimal string, never `amountCents`.
- `currency` is required. Operations never mix currencies.
- `scale` is required and explicit. JPY has scale 0, KWD has 3; nothing
  assumes 2.
- Everything is bounded by construction: amounts up to 96 digits
  (uint256 fits with headroom), scale up to 64, currency up to 32
  characters. Hostile input past a bound is `INVALID_MONEY` and cannot
  buy unbounded CPU or memory.
- `Money` is branded with a NON-EXPORTED unique symbol: only the
  module's constructors mint it, and no hand-written literal
  type-checks as `Money`, not even one that spells out a `__brand`
  property. Re-hydrate foreign plain shapes with `moneyFromUnknown`
  (validates, copies, and freezes, so a later mutation of the input
  cannot reach domain state) or `moneyFromDto` for wire strings; the
  boundary parsers take `unknown`, so no cast is ever needed before
  validation. `isMoney` is a CHECK, not a door: it neither copies nor
  freezes.

## Exact operations only

The kit ships the money contract and every operation that cannot lose
information: construction, validation, the wire format, parsing,
formatting, and the lossless arithmetic (`addMoney`, `subtractMoney`,
`negateMoney`, lossless `rescaleMoney`). These are small, exact, and
total.

Everything that carries a rounding or distribution POLICY is
deliberately not implemented here: multiplication, ratios, fees,
division, lossy rescaling, allocation (splitting 10.00 EUR three ways
must hand out 3.34 + 3.33 + 3.33, not round three times), and FX.
Whether tax rounds per line or per invoice, inclusive or exclusive,
and in which order, is domain policy, not generic money mechanics.
The pattern: your domain NAMES the policy in ubiquitous language, and
a battle-tested calculation library EXECUTES it behind that name,
bridged through the snapshot helpers:

```ts
// Domain services named after the policy, not the mechanics. Inside,
// they bridge Money to your calculation library and back.
const gross = calculateVat(net, vatPolicy);
const installments = allocateInstallments(total, paymentPlan);
const settled = convertCurrency(source, quotedRate);
```

| Concern | Helper |
| --- | --- |
| Domain state, events, snapshots | `Money` (plain, frozen, clone-safe) |
| Lossless arithmetic (same currency and scale) | `addMoney`, `subtractMoney`, `negateMoney` |
| Lossless scale alignment | `rescaleMoney` (inexact conversions throw) |
| JSON wire format | `MoneyDto`, `moneyFromDto`, `moneyToDto` |
| Exact input parsing | `parseMoneyInput` |
| Calculation-library bridge (lossy math, allocation, FX) | `moneyFromSnapshot`, `moneyToSnapshot` |
| Currency scales, wired once | `createMoneyFactory` + resolvers |
| Display | `formatMoney`, `createMoneyFormatter` |

The division of labor in one use case, shown with dinero.js (any
library with the same snapshot shape works identically):

```ts
import { dinero, multiply, toSnapshot } from "dinero.js";
import {
  moneyFromSnapshot,
  moneyToDto,
  moneyToSnapshot,
  parseMoneyInput,
} from "@shirudo/ddd-kit/money";

// 1. Boundary in: exact parse, no floats involved
const amount = parseMoneyInput(input.amount, { currency: "EUR", scale: 2 });

// 2. Domain: Money lives in aggregate state and domain events
order.addLine(sku, amount);

// 3. Calculation: bridge to dinero, compute, store the result back
const net = dinero(moneyToSnapshot(order.net));
const gross = multiply(net, { amount: 119, scale: 2 });
order.applyGross(moneyFromSnapshot(toSnapshot(gross)));

// 4. Boundary out: JSON-safe DTO, amountMinor as a string
res.json(moneyToDto(order.total));
```

## Why plain data matters in this kit

Calculation-library objects carry functions and internals. They do not
survive `structuredClone`, and they do not belong in aggregate state or
event payloads that the kit deep-freezes, snapshots, and diffs for
optimistic concurrency. `Money` is a frozen plain record, so it passes
every one of those machines untouched. Keep library objects inside the
use case; store `Money`.

## Parsing input

`parseMoneyInput` is the safe replacement for the classic bug
`Number(input) * 100`:

```ts
parseMoneyInput("10.99", { currency: "EUR", scale: 2 });  // 1099n
parseMoneyInput("10", { currency: "JPY", scale: 0 });     // 10n
parseMoneyInput("10.5", { currency: "EUR", scale: 2 });   // 1050n (lossless pad)
parseMoneyInput("10.990", { currency: "EUR", scale: 2 }); // 1099n (lossless)

parseMoneyInput("10.999", { currency: "EUR", scale: 2 });
// throws MONEY_PRECISION_LOSS: exact parse or rejection, NEVER rounding
```

**Parsing is exact or it fails; the kit never rounds.** Whether
`10.999 EUR` should be rejected or become `11.00 EUR` is a business
decision, not a parsing feature, and a generic `rounding` parameter on
a parser would hide that decision behind a technical knob. When your
domain wants to accept over-precise input, give the decision a name
and a home:

```ts
// A domain-named policy function: it says WHOSE rule this is, rounds
// via your calculation library, and returns Money.
function normalizeQuotedPrice(raw: unknown): Money {
  // parse exactly at the supplier feed's precision, then apply the
  // pricing policy's rounding through the snapshot bridge
  const quoted = parseMoneyInput(raw, { currency: "EUR", scale: 4 });
  return moneyFromSnapshot(toSnapshot(applyPricingPolicy(quoted)));
}
```

The grammar is strictly `/^-?\d+(\.\d+)?$/`. No exponents, no
`Infinity`, no locale separators; normalize UI input ("10,99") before
calling.

Input longer than 256 characters is rejected outright, before any
conversion work, and error messages truncate what they echo: a hostile
multi-megabyte "amount" costs O(1) and never lands in your logs.

## The wire format

JSON numbers are floats, and `JSON.stringify` throws on bigint. Money
therefore travels as a string:

```json
{ "amountMinor": "1099", "currency": "EUR", "scale": 2 }
```

`moneyFromDto` validates (`/^-?\d+$/`) and converts immediately after
deserialization; `moneyToDto` emits right before serialization. The same
applies to persistence: store `amount_minor` as a SQL `bigint` (not
`integer`, never a float type) alongside `currency` and `scale`.

Domain events that carry money should carry the `Money` shape; if your
event store serializes payloads as JSON, convert to the DTO shape in the
store adapter, exactly like any other bigint field.

## Currency scales, wired once

The kit ships **no currency table**; which currencies exist and which
scale they use is the consumer's decision. Wire a resolver once at the
composition root:

```ts
import {
  createMoneyFactory,
  currencyScaleFromIntl,
  currencyScaleFromRecord,
} from "@shirudo/ddd-kit/money";

// a) explicit record: a closed, auditable set
const fromRecord = createMoneyFactory({
  scaleFor: currencyScaleFromRecord({ EUR: 2, USD: 2, JPY: 0 }),
});

// b) the runtime's own ICU data: zero shipped tables
const fromIntl = createMoneyFactory({ scaleFor: currencyScaleFromIntl() });

// c) your calculation library's currency package: a one-liner
//    (here: @dinero.js/currencies)
import * as currencies from "@dinero.js/currencies";
import type { Currency } from "dinero.js";

const money = createMoneyFactory({
  scaleFor: (code) =>
    (currencies as Record<string, Currency<number>>)[code]?.exponent,
});

money.parse("10.99", "EUR"); // scale resolved to 2
money.ofMinor(1099n, "EUR");
money.zero("JPY");
money.scaleOf("CHF"); // throws UNKNOWN_CURRENCY if unresolved
```

`currencyScaleFromIntl` is a CONVENIENCE, not an enterprise source of
truth: it resolves only canonical uppercase codes ("eur" is not a
silent alias for "EUR"), but ICU resolves well-formed UNASSIGNED codes
to its default of 2 instead of `undefined`, and the data shifts with
the runtime's ICU version. For production money paths, pin a closed,
versioned currency map (option a) or your calculation library's
versioned currency package (option c); reach for the Intl resolver in
demos, prototypes, and internal tooling.

## Bridging to a calculation library

`moneyFromSnapshot` and `moneyToSnapshot` speak the structural
`{ amount, currency, scale }` snapshot shape that the common calculation
libraries serialize to and construct from (dinero.js's `toSnapshot()` /
`toJSON()` result, for example), with no dependency on any of them. The
anti-corruption checks run once, at the boundary:

- non-decimal currencies are rejected (currency packages model MGA and
  MRU with base 5; their minor units do not map onto a power-of-ten
  scale)
- `number` amounts must be safe integers; fractional or beyond-2^53
  amounts throw instead of corrupting silently
- `bigint` calculator snapshots pass through exactly

`moneyToSnapshot` emits number-based snapshots (the libraries' default
calculators are number-based) and refuses amounts past
`Number.MAX_SAFE_INTEGER`; wire such amounts into a bigint calculator
directly from `money.amountMinor`.

With dinero.js, the round-trip is:

```ts
import { add, dinero, toSnapshot } from "dinero.js";
import {
  moneyFromSnapshot,
  moneyOfMinor,
  moneyToSnapshot,
} from "@shirudo/ddd-kit/money";

const a = dinero(moneyToSnapshot(moneyOfMinor(1099n, "EUR", 2)));
const b = dinero(moneyToSnapshot(moneyOfMinor(901n, "EUR", 2)));

const sum = moneyFromSnapshot(toSnapshot(add(a, b)));
// { amountMinor: 2000n, currency: "EUR", scale: 2 }
```

For amounts past 2^53, use dinero's bigint calculator and skip the
number-based snapshot on the way in; on the way back,
`moneyFromSnapshot` accepts bigint snapshots exactly:

```ts
import { createDinero, toSnapshot } from "dinero.js";
import { calculator } from "@dinero.js/calculator-bigint";

const dineroBigint = createDinero({ calculator });
const EUR = { code: "EUR", base: 10n, exponent: 2n };

const large = dineroBigint({
  amount: money.amountMinor, // bigint, no conversion, no precision cliff
  currency: EUR,
  scale: BigInt(money.scale),
});

const back = moneyFromSnapshot(toSnapshot(large));
```

## Display

Formatting is presentation only. It feeds `Intl.NumberFormat` the exact
decimal string, never a float, and its output must never flow back into
parsing or arithmetic:

```ts
formatMoney(moneyOfMinor(1099n, "EUR", 2), "de-DE"); // "10,99 €"

const format = createMoneyFormatter("en-US"); // caches formatters
format(moneyOfMinor(9007199254740993n, "USD", 2));
// "$90,071,992,547,409.93": exact past 2^53
```

## A full slice through the hexagon

One money value crosses four seams, and each seam has exactly one
correct shape: a decimal **string** at the UI edge, **`Money`** inside
the hexagon, a **`bigint` column triple** in the database, and
**`MoneyDto`** on the wire out. Everything below is the same invoice
example; the kit machinery (identity map, OCC mapping, outbox) is each
linked guide's topic, so only the money seams are spelled out.

### Database (schema)

```sql
create table invoice (
  id             text     primary key,
  version        integer  not null,
  customer_id    text     not null,
  status         text     not null,
  total_minor    bigint   not null,
  total_currency char(3)  not null check (total_currency ~ '^[A-Z]{3}$'),
  total_scale    smallint not null check (total_scale between 0 and 12)
);

create table invoice_line (
  invoice_id      text     not null references invoice(id),
  position        integer  not null,
  sku             text     not null,
  amount_minor    bigint   not null check (amount_minor >= 0),
  amount_currency char(3)  not null,
  amount_scale    smallint not null,
  primary key (invoice_id, position)
);
```

`bigint`, never `integer` (2^31 minor units caps a 2-scale currency at
about 21 million) and never a float type. The `amount_minor >= 0` check
is for prices; ledger tables drop it because the sign carries meaning.

One range caveat, stated explicitly because the two bounds differ: SQL
`bigint` is signed 64-bit (up to ~9.2e18, 19 digits), while the domain
shape admits amounts up to 96 digits. For fiat money, `bigint` is the
right column and its range is beyond any real balance sheet; if your
domain actually uses the headroom (uint256 token amounts), store
`numeric(96, 0)` instead and add
`check (amount_minor between -1e96 and 1e96)`. The same asymmetry
exists at the snapshot bridge, where `moneyToSnapshot` refuses amounts
past 2^53; the storage adapter is where you decide which range your
system really supports.

### Domain (inside the hexagon)

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
  type Money,
} from "@shirudo/ddd-kit/money";

type InvoiceId = Id<"InvoiceId">;

type InvoiceState = {
  customerId: string;
  lines: ReadonlyArray<{ sku: string; amount: Money }>;
  total: Money; // Money in aggregate state: plain, frozen, exact
  status: "open" | "issued";
};

type InvoiceIssued = DomainEvent<
  "InvoiceIssued",
  { invoiceId: InvoiceId; total: Money } // Money in event payloads too
>;
type InvoiceEvent = InvoiceIssued;

class InvoiceLineRejectedError extends DomainError<"INVOICE_LINE_REJECTED"> {
  constructor(reason: string) {
    super({ code: "INVOICE_LINE_REJECTED", message: reason });
  }
}

class Invoice extends AggregateRoot<InvoiceState, InvoiceId, InvoiceEvent> {
  protected readonly aggregateType = "Invoice";

  // `zero` fixes the invoice's currency AND scale at opening time:
  // pass money.zero("EUR") from your composition root's factory.
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
    // Domain invariants speak the contract's language:
    if (isNegativeMoney(amount)) {
      throw new InvoiceLineRejectedError("line amounts must not be negative");
    }
    // Lossless contract arithmetic: exact, and the currency/scale
    // match is enforced by addMoney itself (MONEY_CURRENCY_MISMATCH /
    // MONEY_SCALE_MISMATCH). No third-party import, no rounding.
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

Note what the domain does NOT import: the calculation library. Summing
aligned lines is lossless contract arithmetic, so the aggregate needs
nothing beyond the kit it is already built on. Lossy math moves to the
use case as NAMED policy (`calculateVat(net, vatPolicy)`, an
installment allocation, a payout split), and the calculation library
executes it behind that name via the snapshot bridge, where the
rounding policy is explicit and reviewable.

### Port and driven adapter (repository)

```ts
interface InvoiceRepository {
  getByIdOrFail(id: InvoiceId): Promise<Invoice>;
  save(invoice: Invoice): Promise<void>;
}
```

The adapter is where rows become `Money` and `Money` becomes
parameters, in exactly one place. node-postgres returns SQL `bigint`
columns as strings, which is precisely the `MoneyDto` discipline, so
the row mapping IS `moneyFromDto`:

```ts
import { type Money, moneyFromDto } from "@shirudo/ddd-kit/money";

function moneyFromColumns(
  minor: string,
  currency: string,
  scale: number,
): Money {
  return moneyFromDto({ amountMinor: minor, currency, scale });
}

class PgInvoiceRepository implements InvoiceRepository {
  constructor(private readonly tx: PgTx) {}

  async getByIdOrFail(id: InvoiceId): Promise<Invoice> {
    // not-found mapping to AggregateNotFoundError elided
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
          amount: moneyFromColumns(
            line.amount_minor,
            line.amount_currency,
            line.amount_scale,
          ),
        })),
        total: moneyFromColumns(
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
    // bigint parameters travel as strings; toString() is exact.
    // Insert routing, line writes, and the zero-rows-affected to
    // ConcurrencyConflictError mapping follow the repository guide.
    await this.tx.query(
      `update invoice
          set version = $2, status = $3,
              total_minor = $4, total_currency = $5, total_scale = $6
        where id = $1 and version = $7`,
      [
        invoice.id,
        invoice.version,
        invoice.state.status,
        total.amountMinor.toString(),
        total.currency,
        total.scale,
        invoice.persistedVersion, // the OCC baseline
      ],
    );
  }
}
```

An ORM whose driver hands you native `bigint` (Drizzle's
`bigint({ mode: "bigint" })`, for example) skips the string hop: feed
the value to `moneyOfMinor` directly.

### Driving adapter (HTTP in, HTTP out)

```ts
app.post("/invoices/:id/lines", async (req, res) => {
  // Boundary in: the RAW value goes straight into the parser, which
  // takes unknown and validates. Never coerce first: String([...])
  // silently joins arrays. INVALID_MONEY, MONEY_PRECISION_LOSS, and
  // UNKNOWN_CURRENCY surface as 422 through the presentation entry's
  // catalog in your error middleware.
  const amount = money.parse(req.body.amount, "EUR");

  const total = await withCommit({ scope, outbox, bus }, async (tx) => {
    const invoices = new PgInvoiceRepository(tx);
    const invoice = await invoices.getByIdOrFail(asInvoiceId(req.params.id));
    invoice.addLine(String(req.body.sku), amount);
    await invoices.save(invoice);
    return { result: invoice.total, aggregates: [invoice] };
  });

  // Boundary out: amountMinor as a string, never a JSON number.
  res.status(200).json({ total: moneyToDto(total) });
});
```

That is the whole discipline: the decimal string exists for one line at
the edge, the database sees only integers, the wire sees only strings,
and everything between them is exact `bigint` money.

## Errors

All money errors follow the kit's error model (`code === name`,
`category`, `retryable: false`):

| Code | Kind | Raised by |
| --- | --- | --- |
| `INVALID_MONEY` | `DomainError` | malformed amounts, DTOs, inputs, snapshots; anything past a hard bound |
| `MONEY_CURRENCY_MISMATCH` | `DomainError` | `addMoney`/`subtractMoney` across currencies |
| `MONEY_SCALE_MISMATCH` | `DomainError` | `addMoney`/`subtractMoney` across scales (lossless `rescaleMoney` is the explicit alignment) |
| `MONEY_PRECISION_LOSS` | `DomainError` | over-precise input in the exact-only `parseMoneyInput`, or an inexact `rescaleMoney` |
| `UNKNOWN_CURRENCY` | `DomainError` | factory resolver has no entry |

The domain codes are registered in `createKitPublicErrors()` at status
422 with client-safe messages, so they flow through `toPublicErrorView`
and `toProblem` like every other kit error.

## FX

Currency conversion is never just a rate. Resolve rates and multiply in
your FX adapter, then persist the whole conversion record, never just
the result:

```ts
type FxConversion = {
  source: Money;
  target: Money;
  rate: string;
  rateSource: string;
  resolvedAt: Date;
  roundingMode: string; // your calculation library's mode
};
```

Never recompute a historical conversion from a newer rate; the record
above is what makes the booked number explainable years later. The kit
deliberately ships no FX code (rate resolution and multiplication are
your adapter's and calculation library's job), so this shape lives in
your codebase.
