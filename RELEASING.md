# Releasing `@shirudo/ddd-kit`

Package publication is owned by `.github/workflows/release.yml`. Do not run
`npm publish` or `pnpm publish` from a workstation.

## One-time repository setup

### npm trusted publisher

Configure one GitHub Actions trusted publisher for `@shirudo/ddd-kit` with
these exact values:

- organization or user: `shi-rudo`
- repository: `ddd-kit-ts`
- workflow filename: `release.yml`
- environment: `npm`
- allowed action: `npm publish`

The equivalent npm CLI command requires an authenticated maintainer account
with 2FA:

```sh
npm trust github @shirudo/ddd-kit \
  --file release.yml \
  --repo shi-rudo/ddd-kit-ts \
  --env npm \
  --allow-publish \
  --yes
```

The workflow intentionally contains no npm token. Its `publish` job alone can
mint an OIDC token and runs in the matching `npm` GitHub environment. Once the
trusted publisher has succeeded, restrict or revoke any registry write tokens
that are no longer needed.

### GitHub environment and branch protection

Create the `npm` environment without secrets. A required reviewer may be added
for a human release approval; if it is, the npm trusted publisher's environment
must remain exactly `npm`.

Protect `main` with the required status checks `verify (22)` and `verify (24)`.
The release workflow independently repeats the same gates for the tagged commit
and rejects a tag whose commit is not reachable from `main`.

## Cut a release

1. Land the version and changelog on `main` through a pull request.
2. Wait for both required `main` checks to pass.
3. Create a tag that exactly matches `v` plus `package.json`'s version and push
   it. For example:

   ```sh
   version=$(node -p "require('./package.json').version")
   git tag -a "v$version" -m "Release $version"
   git push origin "v$version"
   ```

4. Wait for the `Release package` workflow. It runs typecheck, lint, tests,
   build, and a tarball import smoke on Node 22 and 24. The Node 24 job uploads
   the exact smoke-tested tarball; the OIDC-enabled publish job downloads only
   that immutable artifact and neither checks out source, installs project
   dependencies, nor runs project lifecycle scripts.
5. Verify the published package and its provenance on npm, then create the
   matching GitHub release from the existing tag.

Prerelease versions such as `3.0.0-rc.2` publish under the npm `next` dist-tag.
Stable versions publish under `latest`. The workflow derives this from the
package version; callers cannot select a dist-tag manually.

If publication already succeeded but a later workflow step or UI check failed,
do not try to publish the same version again. Confirm the registry state first;
npm versions are immutable.
