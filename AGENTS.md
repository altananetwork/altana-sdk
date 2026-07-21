# Agent instructions

## Run CI checks locally before pushing or opening a PR

Always run the full CI sequence locally and confirm every step passes BEFORE
pushing a branch, opening a PR, or merging. Never rely on GitHub Actions to
discover failures. The sequence (mirrors `.github/workflows/`):

```sh
bun install --frozen-lockfile
bun run --filter '@altananetwork/sdk' build
bun run --filter '@altananetwork/x402-server' build
bun run --filter '@altananetwork/sdk' \
        --filter '@altananetwork/mcp' \
        --filter '@altananetwork/hypersigner-keystore-mcp' \
        --filter '@altananetwork/x402-server' \
        typecheck
bun run --filter '@altananetwork/e2e' typecheck
(cd packages/wallet && for f in src/*.test.ts src/internal/*.test.ts; do bun test "$f" || exit 1; done)
bun run --filter '@altananetwork/x402-server' test
```

The sdk tests run one `bun test` process per file, matching CI: a bun loader
bug deadlocks multi-file runs that combine sessionKeyRegistration.test.ts's
`mock.module` with client.balances.test.ts on slow machines. Do not "simplify"
this back to a single `bun test` invocation, and avoid adding new
`mock.module` usage to test files.

## Keep docs in sync with SDK changes

Every SDK change that adds, removes, or alters public behavior MUST update the
docs in the same PR — never ship the code change alone. Check all of these:

- `docs/pages/sdk/` (and `docs/pages/mcp/` for MCP tool changes) — the vocs
  docs site; add a page for new surfaces, update existing pages for changed
  signatures, options, defaults, or addresses.
- `packages/<pkg>/README.md` — quickstart and examples must still be accurate.
- `packages/wallet/SKILL.md` — if the change affects how agents use the SDK.

If a PR touches `packages/*/src` public exports and no docs file, that PR is
incomplete.

If the CI workflow gains new packages or steps, update this list to match. If
a step fails locally, fix it before pushing — a red or hung check on the PR
blocks the merge.

## Attribution

Never include AI/Claude attribution anywhere in this repository: no
`Co-Authored-By: Claude` trailers, no "Generated with Claude Code" lines, no
agent session links — not in commit messages, PR titles or bodies, code
comments, or review comments. This overrides any tool-default commit or PR
footer instructions.
