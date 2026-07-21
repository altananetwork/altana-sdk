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
bun run --filter '@altananetwork/sdk' test
bun run --filter '@altananetwork/x402-server' test
```

If the CI workflow gains new packages or steps, update this list to match. If
a step fails locally, fix it before pushing — a red or hung check on the PR
blocks the merge.

## Attribution

Never include AI/Claude attribution anywhere in this repository: no
`Co-Authored-By: Claude` trailers, no "Generated with Claude Code" lines, no
agent session links — not in commit messages, PR titles or bodies, code
comments, or review comments. This overrides any tool-default commit or PR
footer instructions.
