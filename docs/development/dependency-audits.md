# Dependency audit policy

Last reviewed: 2026-07-16

## Release gate

`pnpm audit:prod` runs `pnpm audit --prod` on every pull request and push to
`main`. Any advisory in the installed production dependency graph fails CI.

The package currently has no regular `dependencies`; its runtime collaborators
are peer dependencies selected by each consumer. The production audit therefore
guards future additions to this package's runtime graph, but it cannot certify a
consumer application's chosen peer-dependency graph. Consumers must audit their
own lockfiles as part of their release process.

The full `pnpm audit` also scans the documentation, test, mutation, and build
toolchains. It is reviewed separately because accepted development-only findings
would otherwise hide whether the production graph is clean.

## Current development-toolchain triage

Moving the lockfile forward with pnpm 11 and applying a compatible `qs` 6.15.2
override removed 20 of the 25 findings reported on 2026-07-16. Moving the
documentation build to VitePress 2.0.0-alpha.18 and Vite 8 removed the four
findings retained by VitePress 1.6.4's Vite 5 toolchain. One development-only
finding remains accepted:

| Advisory | Severity | Path | Decision |
| --- | --- | --- | --- |
| [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | Low | `tsup > esbuild@0.27.7` | Accepted because the package build uses esbuild's build API, not its development server. tsup 8.5.1 declares `esbuild@^0.27.0`; upgrade when tsup supports esbuild 0.28.1 or newer. |

Re-run both `pnpm audit:prod` and `pnpm audit` whenever the lockfile or toolchain
changes. Revisit the accepted finding when tsup supports esbuild 0.28.1 or
newer.
