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
