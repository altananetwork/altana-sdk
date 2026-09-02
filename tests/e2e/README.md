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

### Fork RPC endpoints

The fork tests fork BNB Smart Chain and Base. They read dedicated RPC endpoints
from env, falling back to public nodes when unset (fine locally, rate-limited in
CI). Point these at a dedicated provider (Alchemy/QuickNode/Ankr, key in the URL)
for reliable runs:

```bash
# .env at repo root (gitignored)
BSC_FORK_RPC_URL=https://.../<KEY>          # fork-x402, fork-x402-witness, fork-erc1271, fork-bep677, fork-uniswap-v4
BASE_FORK_RPC_URL=https://.../<KEY>         # fork-eip3009
BSC_TESTNET_FORK_RPC_URL=https://.../<KEY>  # fork-erc8004, fork-erc8183
```

All three are set as GitHub Actions secrets of the same names and passed to the
"On-chain fork tests" job.

## ERC-8004: what runs where

`fork-erc8004.ts` is in `fork:all`, so it runs on every CI build. It covers the
registry against real bytecode (register, the `setAgentURI` owner gate, the
two-phase record), the `_safeMint` receiver check for an EIP-7702 account
delegated to the relay's real account proxy, and the selector-scoped permission
policy — authorizing a session key on a delegated account exactly as a grant
does, then asking the account's own `canExecute` what that key may do.

`fork-erc8183.ts` is also in `fork:all`: the full ERC-8183 buyer lifecycle
(createJob → registerJob → setBudget → approve → fund, then expiry + refund)
against the real BSC-testnet kernel bytecode. Among other things it pins the
bundled policy address to the router's live whitelist — a wrong entry there
reverts every hire with `PolicyNotWhitelisted()` (issue #53).

`live-erc8004-testnet.ts` adds only the **relay leg**: a session-signed intent
for a `signature`-scoped key going through `wallet_prepareCalls` →
`wallet_sendPreparedCalls`. It cannot run unattended, and not for want of
wiring — the BSC-testnet relay rejects an unfunded wallet at `prepareCalls`, and
its faucet (`fundNative`) is a no-op that returns a hash for a transfer to `0x0`
and moves nothing. So it needs a manually funded admin EOA (~0.05 tBNB):

```bash
ALTANA_TESTNET_ADMIN_KEY=0x… bun run --filter '@altananetwork/e2e' live:erc8004-testnet
```

Wire that key in as a secret to make it a release gate; without it the script
fails loudly rather than skipping silently.

## Run

```bash
# one test
bun run tests/e2e/smoke-mcp.ts

# all smokes in order
bun run --filter '@altananetwork/e2e' smoke:all
```

## What each does

- `smoke-test.ts`: wallet creation + first execute + KeyStore admin auto-registration
- `smoke-session.ts`: full session lifecycle: grant → execute → revoke → post-revoke deny
- `smoke-passkey.ts`: passkey-backed admin: create, execute, grant, session execute, revoke
- `smoke-grant-first.ts`: registers admin via grantSession instead of first execute
- `smoke-mcp.ts`: drives the MCP server over JSON-RPC stdio, end-to-end Path B flow
- `spike-*.ts`: research scripts; not part of the smoke suite, kept for reference

## Fork tests

Self-contained anvil mainnet forks; no env vars or funded keys needed (requires `anvil` on PATH). Run directly, e.g. `bun tests/e2e/fork-bep677.ts`.

- `fork-x402.ts`, `fork-x402-witness.ts`, `fork-eip3009.ts`, `fork-erc1271.ts`: x402 payment rails against real tokens
- `fork-native-receive.ts` (in `fork:all`): pins the EIP-7702 native-receive limitation — a 2300-gas-stipend payout (`.transfer()`/`.send()`) to a delegated wallet reverts, full-gas `call{value:}` succeeds, and Venus vBNB `redeem` reproduces the real-world failure (issue #55)
- `fork-bep677.ts`: BEP-677 scaled-UI-amount display in `client.balances` (mock BEP-677 tokens + real USDT on a BSC fork)
- `fork-uniswap-v4.ts` (in `fork:all`): Uniswap v4 liquidity against the real BNB Chain PositionManager — the selector-scoped permission gate on a delegated account (`modifyLiquidities` allowed, every ERC-721 selector refused), then mint → increase → collect → decrease → burn of a single-sided BNB position on the live BNB/USDT 0.05% pool
