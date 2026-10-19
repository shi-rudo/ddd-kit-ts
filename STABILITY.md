# Stability policy

This policy applies from 3.0.0. It says what a release may change, so that a
production project can update without surprises.

## Versions

The package follows [Semantic Versioning](https://semver.org/). A breaking
change of the stable API needs a new major version.

Only the newest major version gets releases. When 4.0.0 is released, 3.x gets
no more fixes. Plan the migration to a new major version when it is released.

Release candidates of a major version publish under the npm dist-tag `next`.
They are previews: a later release candidate can break an earlier one. The
migration guide has an appendix for each step between release candidates.

## The stable API

The stable API is:

- every name that `@shirudo/ddd-kit`, `@shirudo/ddd-kit/http`,
  `@shirudo/ddd-kit/public-errors`, and `@shirudo/ddd-kit/testing` export,
  values and types
- the error codes in `KitErrorCode`, and the `code` and `name` of every kit
  error
- the behavior that the guides and the JSDoc state
- the port contracts that the contract suites in `@shirudo/ddd-kit/testing`
  check

These are not part of the stable API:

- the text of an error message. Match on the code, not on the message.
- a module path that `package.json` does not export, for example a file under
  `dist/` or `src/internal/`
- performance and memory use, unless a guide states a bound
- the two experimental entry points (see below)

## Breaking changes

A change is breaking when it does one of these:

- removes or renames an export, a method, a property, or an option
- changes a type so that code that compiled before no longer compiles, for
  example a narrower parameter type or a wider return type
- changes or removes an error code, or throws another error class on a
  documented path
- changes documented behavior
- drops a Node.js LTS line, or raises the major version of a peer dependency

These changes are not breaking:

- a new export, a new optional option, or a new error code for a new case
- a new or better message text
- a fix that makes the behavior match the documentation
- a new check in a contract suite for a rule that the documentation already
  states
- a higher TypeScript minimum in a minor release, if the new minimum version
  was released at least 6 months before (see Runtimes)

## Deprecation

Before a name is removed, a minor release marks it `@deprecated` and names its
replacement, and the CHANGELOG lists it under "Deprecated". The name stays for
at least one minor release. Only the next major version removes it.

## Experimental entry points

`@shirudo/ddd-kit/state-machine` and `@shirudo/ddd-kit/money` are
experimental. A minor release can change them in a breaking way. The CHANGELOG
lists every such change under "Changed (breaking)" with the minor version. If
you depend on one of them, pin the minor version, for example with `~3.1.0`.

When an experimental entry point becomes stable, the CHANGELOG says so, and
this policy moves it to the stable API.

## Runtimes

- Node.js: the supported LTS lines, `>=22` at 3.0.0. Only a major version
  drops a Node.js LTS line.
- TypeScript: 5.9 or later at 3.0.0. A minor release can raise the minimum,
  but only to a TypeScript version that was released at least 6 months
  before.
- Edge runtimes: Cloudflare Workers, Vercel Edge, Deno, and Bun. CI runs the
  package in Cloudflare `workerd` and in the Vercel Edge Runtime. A failure in
  a supported runtime is a bug.

## How the policy is checked

- `test/architecture/api-surface.test.ts` pins the runtime names that each
  entry point exports. A pull request that changes the public surface changes
  this test, and its description says whether the change is breaking.
- The packed-package smoke in CI installs the tarball and imports every entry
  point with strict type checking.
- The CHANGELOG records every change under its Keep a Changelog section. A
  breaking change also gets an entry in the migration guide of its major
  version.
