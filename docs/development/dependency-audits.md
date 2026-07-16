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

Moving the lockfile forward with pnpm 11 removed 20 of the 25 findings reported
on 2026-07-16. A compatible `qs` 6.15.2 override removes the remaining Stryker
transitive finding. Five development-only findings remain accepted:

| Advisory | Severity | Path | Decision |
| --- | --- | --- | --- |
| [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99) | Moderate | `vitepress > vite > esbuild@0.21.5` | Accepted until stable VitePress supports a patched Vite line. The affected esbuild development server is not used by the documentation build. |
| [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) | Moderate | `vitepress > vite@5.4.21` | Accepted for the local documentation server only. CI builds static documentation and does not expose a Vite server. |
| [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) | Moderate | `vitepress > vite@5.4.21` | Accepted for the local documentation server only. Do not expose `pnpm docs:dev` beyond its default loopback binding. |
| [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) | High | `vitepress > vite@5.4.21` | Accepted with the same loopback-only restriction. Stable VitePress 1.6.4 declares `vite@^5.4.14`; forcing Vite 6 outside that range would replace a known development-only exposure with an unsupported toolchain combination. |
| [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | Low | `tsup > esbuild@0.27.7` | Accepted because the package build uses esbuild's build API, not its development server. tsup 8.5.1 declares `esbuild@^0.27.0`; upgrade when tsup supports esbuild 0.28.1 or newer. |

Re-run both `pnpm audit:prod` and `pnpm audit` whenever the lockfile or toolchain
changes. Revisit the accepted findings when a stable VitePress release supports
Vite 6.4.3 or newer, or when tsup supports esbuild 0.28.1 or newer.
