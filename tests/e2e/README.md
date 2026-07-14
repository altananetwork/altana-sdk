# @altananetwork/e2e

End-to-end smoke and spike tests for `@altananetwork/sdk` and `@altananetwork/mcp`. Hit live Sepolia testnet through the Porto relay.

**Private workspace package.** Not published to npm. CI-only + manual dev use.

## Env

Every script requires `TEST_FUNDER_KEY`: a funded Sepolia private key that bankrolls the freshly-generated admin wallet each test creates.

```bash
# .env at repo root (gitignored)
TEST_FUNDER_KEY=0x...
```

The same key is set as a GitHub Actions secret of the same name for CI runs.

**Never put this key on mainnet.** Treat it as known-leaked: it's used by anyone with repo access.

## Run

```bash
# one test
bun run tests/e2e/smoke-mcp.ts

# all smokes in order
bun run --filter '@altananetwork/e2e' smoke:all
```

## What each does

- `smoke-test.ts` — wallet creation + first execute + KeyStore admin auto-registration
- `smoke-session.ts` — full session lifecycle: grant → execute → revoke → post-revoke deny
- `smoke-passkey.ts` — passkey-backed admin: create, execute, grant, session execute, revoke
- `smoke-grant-first.ts` — registers admin via grantSession instead of first execute
- `smoke-mcp.ts` — drives the MCP server over JSON-RPC stdio, end-to-end Path B flow
- `spike-*.ts` — research scripts; not part of the smoke suite, kept for reference

## Fork tests

Self-contained anvil mainnet forks; no env vars or funded keys needed (requires `anvil` on PATH). Run directly, e.g. `bun tests/e2e/fork-bep677.ts`.

- `fork-x402.ts`, `fork-x402-witness.ts`, `fork-eip3009.ts`, `fork-erc1271.ts` — x402 payment rails against real tokens
- `fork-bep677.ts` — BEP-677 scaled-UI-amount display in `client.balances` (mock BEP-677 tokens + real USDT on a BSC fork)
