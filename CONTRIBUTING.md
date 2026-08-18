# Contributing

Thanks for your interest in improving the Altana SDK!

## Branch flow

- **Base every PR on `staging`** (the default branch). `staging` accumulates
  changes for the next SDK release.
- `main` reflects the currently published SDK. Promotion (`staging` → `main`)
  happens at publish time, is maintainer-only, and is always a merge commit.
- At publish time a maintainer replaces `Unreleased` in the pending section's
  heading with the release date (the version is already there), confirms the
  `package.json` versions match it, publishes to npm, and merges `staging` →
  `main` — so `main`'s changelog always ends at the published version.

## Dev setup

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
```

Run the wallet package's tests **one file at a time** — multi-file runs can
deadlock because bun shares one module registry across test files (see the
note in `.github/workflows/e2e.yml`):

```sh
cd packages/wallet
bun test src/sessionKeyRegistration.test.ts   # etc., per file
```

## Pull requests

- Keep PRs focused: one bug or feature per PR.
- Add or update tests for behavior changes, and say how you tested in the PR
  description.
- **Add a `CHANGELOG.md` entry under the pending release section** — the
  `## [x.y.z] - Unreleased` heading at the top — for any user-visible change
  to the published packages (new API, behavior change, bug fix).
  Internal-only changes (CI, docs, repo tooling) don't need one. The section
  accumulates on `staging` and becomes the release notes of that version.
- The pending section is named for the version it will become, and the
  publishable `package.json` versions on `staging` match it. The first
  user-visible change of a cycle creates the section and bumps the versions:
  a fix starts a patch (`0.8.1`), a feature starts a minor (`0.8.0` →
  `0.9.0`; pre-1.0, breaking changes also go in minors). A later feature
  landing in a patch cycle raises it to the next minor — the target version
  only ever goes up within a cycle, never down.
- CI must be green. If you're contributing from a fork, the on-chain
  fork-tests job is skipped (it needs repository secrets that fork PRs never
  receive); the build/typecheck/unit-test job is the gate for your PR.
- A maintainer will review before anything is merged. First contribution?
  Welcome — the PR template asks for everything we need.

## Security

Please do not report vulnerabilities via public issues or PRs — see
[SECURITY.md](SECURITY.md).
