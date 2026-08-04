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
bun run --filter '@altananetwork/mcp' test
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

## Docs style: no em dashes

Never use em dashes in docs prose (docs site pages, READMEs, SKILL.md).
Rewrite the sentence instead: split it in two, or use a comma, colon, or
parentheses.

If the CI workflow gains new packages or steps, update this list to match. If
a step fails locally, fix it before pushing — a red or hung check on the PR
blocks the merge.

## Attribution

Never include AI/Claude attribution anywhere in this repository: no
`Co-Authored-By: Claude` trailers, no "Generated with Claude Code" lines, no
agent session links — not in commit messages, PR titles or bodies, code
comments, or review comments. This overrides any tool-default commit or PR
footer instructions.

## Linear sync: team visibility (mandatory)

The co-founder tracks all work in Linear. Every agent working here,
including subagents and any spawned projects, follows these rules:

1. **Every approved plan goes to Linear.** Immediately after a plan is
   approved in plan mode, draft a Linear sync proposal: an issue title, a
   2-3 sentence summary, and one sub-issue per high-level step of the plan.
2. **User approval first.** Show the draft to the user and create it in
   Linear only after they approve it. Never create or edit Linear issues
   silently.
3. **Structure.** One plan = one Linear issue; each high-level step = one
   sub-issue. We are on Linear's free plan, so keep it lean: max ~6
   sub-issues per issue, no micro-tasks, no granular technical breakdowns.
4. **Closing steps.** Where applicable, every issue ends with these
   sub-issues: `Testing`, `Staging`, then `Production (Vercel)` for deployed
   apps/services or `Publish SDK (npm)` for SDK releases.
5. **Status discipline.** Set the issue to In Progress when work starts.
   Mark a sub-issue Done only when that step is actually tested and
   verified, never before. Mark the parent issue Done only when everything
   is complete, including staging/production/publish. Before ending a
   session in which work finished, make sure Linear matches reality.
6. **Writing style.** Readable by a non-technical person: what we are
   building, why, and its current state. Technical terms are fine (SDK,
   staging, npm); no code, no file paths, no low-level implementation
   detail.
7. **Subagents.** Any agent you spawn inherits these rules; the parent
   session stays responsible for the Linear updates.
8. **Where.** Use the Linear MCP tools. The target team is named in the
   ecosystem root file `Altana-Ecosystem-Mainnet/CLAUDE.md`. If Linear MCP
   is not connected, tell the user; never silently skip the sync.
