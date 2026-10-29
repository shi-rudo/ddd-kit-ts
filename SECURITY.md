# Security

This file maps the security boundaries of version 3 of `@shirudo/ddd-kit`.
Read it before you change code at one of these boundaries. If a change moves
a boundary, update this file in the same change.

## Reporting a vulnerability

Report a vulnerability privately through
[GitHub private vulnerability reporting](https://github.com/shi-rudo/ddd-kit-ts/security/advisories/new).
Do not open a public issue for it.

## Supported versions

Only version 3 gets security fixes.

- A release candidate gets no fix of its own. The next release candidate
  carries the fix.
- From 3.0.0, the newest major version gets the fixes, as the
  [stability policy](STABILITY.md#versions) says.
- Version 2 and older get no fixes. This includes 2.2.0 under the npm
  dist-tag `latest`.

## Trust model

The kit catches accidents, not misuse. It is no security boundary against
code in the same process. A `Proxy` that lies, a forged prototype, or a
subclass that turns off a guard can get past every check. See
[The kit catches accidents, not misuse](docs/guide/design-decisions.md).

Untrusted input is different. Parse it at the boundary, for example with a
schema, before it reaches the kit. The checks of the kit are a second line,
not the first.

The runtime code calls no `eval` and no `new Function`, and it uses no
dynamic `import`. It opens no network connection and no file. It imports
only its two peer packages, `@shirudo/base-error` and `@shirudo/result`.

## What reaches a client

Only the public error helpers write data for a client.

- `toPublicErrorView` and a catalog from `createKitPublicErrors()` give
  `code`, `message`, `locale`, `retryable` for `CONCURRENCY_CONFLICT`, and
  `details.issues` for a validation error. The catalog messages are fixed
  English texts. They carry no id, no version, and no technical detail.
- Every value without a catalog entry becomes `INTERNAL_ERROR`, and the
  wiring errors of the kit are such values. `toPublicErrorView` does not
  throw for any input. If the catalog fails, it gives the fallback view and
  reports the failure to `onCatalogError`.
- A validation issue crosses with `path`, `pointer`, and `code`. Its
  `message` crosses only with `issueMessages: true`, because the default
  message of a validator can embed the rejected value. One whitelist,
  `src/presentation/errors/public-issues.ts`, serves `toPublicErrorView` and
  `toProblemDetails`. It also drops a message that a duck-typed
  `publicIssues()` returns without the opt-in.
- `toProblemDetails` takes a `ValidationError`. It is not total over a
  hostile value. The body comes from `toProblem` of `@shirudo/base-error`:
  it is deeply frozen, has a null prototype, and holds JSON-safe members
  only.
- A value whose `code` matches a catalog code gets that public view. Such a
  value can choose among the fixed texts and statuses. It can put text on
  the wire only through the `path`, `pointer`, and `code` strings of an
  issue, and through `message` with the opt-in.

The `message`, the `details`, and the log object of a kit error are for logs
only. Never send them to a client.

## What reaches a log

The kit writes no log itself. It builds the log object of each error, and
the consumer decides where that object goes.

- The messages and fields of kit errors carry occurrence data: aggregate
  types and ids, versions, event ids, idempotency keys, fingerprints, and
  claim tokens. Treat such logs as confidential, or mask these fields with
  the redaction of `@shirudo/base-error`.
- Some codes put the rejected input value into `details`, for example
  `INVALID_VERSION`.
- `EVENT_PAYLOAD_INVALID` names only the paths of up to three issues in its
  message. Its `issues` keep the messages of the schema, and a validator
  message can embed the rejected value. If a logger writes `issues`, it
  writes these messages. With pino, mask them with
  `redact: ["err.issues[*].message"]`.
- A wrapped driver error stays as `cause`. A dead letter of the in-memory
  outbox keeps the full event and the message of the last error.
- A kit error logs each field that its class declares, at every depth of a
  cause chain. A field that holds a `BaseError` logs through the log object
  of that error, so the redaction policy of that error holds. The kit itself
  masks nothing.
- `@shirudo/base-error` bounds the log build: 100 cause levels, 100 own
  fields per node, a data depth of 100, and 100,000 nodes.

## Untrusted input

- **Plain data.** `copyPlainData` (`src/internal/structural/plain-data.ts`)
  copies and checks event payloads and metadata, the output of an event
  schema, and value-object props. It also copies and checks snapshots, the
  state of the domain state machine, and the events of the in-memory event
  store. A value that is not plain data fails with `TypeError` and names its
  path. An own `__proto__` key at any depth fails with the wiring code
  `PROTOTYPE_POLLUTION`.
- **Root-only checks.** Four operations check only the root object for an
  own `__proto__` key. They do not walk nested objects. The operations are
  the entity (constructor and `setState`), the event-sourced fold (`apply`
  and replay), `copyMetadata`, and `mergeMetadata`. An event made from the
  merged metadata gets the plain-data check at every depth. Code that reads
  the merged metadata directly gets no such check.
- **Event definitions.** `defineDomainEvent` validates the payload with a
  Standard Schema and copies the output under the plain-data rule. The kit
  does not compare the input with the output, so use a strict object schema.
- **Integration messages.** `assertJsonValue` (`src/internal/json-value.ts`)
  rejects every value that is not JSON data, and every `__proto__` key. The
  kit checks the payload for JSON safety only, not against a schema.
- **Command messages.** `routeEventsToCommandOutbox` checks the command
  schema and fails with `INVALID_COMMAND_MESSAGE`. It drops an invalid
  `traceparent` or `tracestate` instead of throwing. The kit does not
  validate the trace fields of `EventMetadata`.
- **Money.** `parseMoneyInput` and `moneyFromDto` limit the input length
  before they call `BigInt`.
- **Hand-built events.** The recording operations accept only events that
  the kit created. This check catches accidents. It is no security boundary.

## Idempotency

The kit does not validate or scope an idempotency key. If a raw client
header is the key, one client can replay or block the request of another
client. Scope the key to the command and to the authenticated actor.
Fingerprint the complete business intention. The
[edge runtimes guide](docs/guide/edge-runtimes.md) shows both. A key with
another fingerprint fails with `IDEMPOTENCY_KEY_REUSE`.

## Identifiers and randomness

- An event id is a UUID v7 from `crypto.getRandomValues`. It holds the time
  and a counter, so a part of it is predictable. An event id is no secret
  and no ordering authority. Do not use it as an access token.
- The application chooses aggregate ids. The kit does not check how
  unpredictable they are.
- The in-memory idempotency stores make claim tokens with
  `crypto.randomUUID()`.
- `Math.random` gives only the jitter of a backoff.

## Resource bounds

Bounded:

- A stream read requires a `limit`, and the kit checks each page.
- The event bus stops a nested publish at a depth of 32.
- The kit checks every timer option. Delivery and storage calls time out
  after 30 seconds by default. A timeout ends the wait, but JavaScript
  cannot stop the promise.
- Retries have a maximum number of attempts, except a plain outbox without
  dead letters, which retries with a capped backoff.

Not bounded:

- `maxPendingEvents` of an aggregate has no limit by default.
- An in-memory adapter has no limit unless you set its capacity option.
- `copyPlainData`, `assertJsonValue`, `deepFreeze`, and `deepEqual` recurse
  without a depth limit. A deeply nested input can overflow the stack with
  `RangeError`. Limit the size and the depth of a request body at the
  boundary.

## More than one copy of the kit

Run one copy of the kit per process. An object from a second copy fails with
`DUPLICATE_KIT_COPY`. The kit accepts an event, an event definition, or an
entity validator only from its own module-private registries. A forged copy
marker changes only the error code, not the result.

`isDomainErrorLike`, `isInfrastructureErrorLike`, and `isWiringErrorLike`
accept every `Error` with the matching `category`. Code in the process can
therefore choose how the kit classifies its error.

## Supply chain and release

- The package has no runtime dependencies. Its two peer packages come from
  the consumer.
- CI installs with a frozen lockfile. pnpm rejects a package version that
  is younger than one day. The `@shirudo` scope is excluded, so the kit can
  adopt a release of its own peers on the day it is published. The lockfile
  still pins each version and its integrity hash.
- Only `esbuild`, `sharp`, and `workerd` may run install scripts.
- The production audit runs on `main`, on a pull request that changes the
  lockfile or the manifest, and once a day. It is not a required check. The
  publish workflow runs the same audit as its gate.
- A version tag starts the publish workflow. It publishes through npm
  Trusted Publishing, without a token, and with provenance. A release
  candidate publishes under `next`.
- A merge to `main` requires every job of the CI workflow (`ci.yml`): the
  tests on Node 24 and 26, the edge runtime smoke test, and the docs build.
  The branch protection of `main` holds this list. If you add a job to
  `ci.yml`, add it to that list too.

## Known gaps

- The GitHub Actions are pinned by major version, not by commit hash. The
  publish workflow installs `npm@11` without a fixed version.
- `ci.yml` and `audit.yml` declare no `permissions` block, so they get the
  default token permissions.
- Administrators can push past the branch protection of `main`. The release
  flow uses this for the version commit.
