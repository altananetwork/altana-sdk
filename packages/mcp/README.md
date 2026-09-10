# @altananetwork/mcp

MCP server that lets AI hosts (Claude Code, Claude Desktop, Cursor, Continue, any MCP
client) operate [Altana](https://altana.network) smart agentic wallets: creating wallets, granting
scoped session keys, executing transactions, and verifying authority on-chain, **without
ever custodying private keys**. Keys are resolved by name from the OS keychain (preferred),
a local file, or env vars, and never appear in tool arguments or results.

## Install

```bash
# Claude Code
claude mcp add altana -- bunx @altananetwork/mcp

# or run directly
bunx @altananetwork/mcp
```

Requires [Bun](https://bun.sh) (the server runs via the `bun` shebang).

## Network

The chain is selected at startup via the `ALTANA_CHAIN` environment variable:

| `ALTANA_CHAIN` | Chain | Relay |
| --- | --- | --- |
| `bnb` (default), `56` | BNB Smart Chain (56) | Altana hosted (`https://relay.altana.network`) |
| `ethereum`, `1` | Ethereum (1) | Altana relay (`https://relay.altana.network`) |
| `bnb-testnet`, `bsc-testnet`, `97` | BNB Smart Chain Testnet (97) | Altana testnet relay |
| `celo-sepolia`, `11142220` | Celo Sepolia (11142220), testnet L2; KeyStore on Sepolia | Altana testnet relay |
| `celo`, `42220` | Celo (42220), L2; KeyStore on Ethereum | Altana relay |

```bash
# Operate on Ethereum instead of the BNB default
ALTANA_CHAIN=ethereum bunx @altananetwork/mcp

# Or the BSC testnet stack
ALTANA_CHAIN=bnb-testnet bunx @altananetwork/mcp

# Or Celo Sepolia
ALTANA_CHAIN=celo-sepolia bunx @altananetwork/mcp
```

An unrecognised value logs a warning and falls back to `bnb`. Sepolia and Base
Sepolia are keystore-only (no relay), so they are not selectable here.

On an L2 (`celo`, `celo-sepolia`) the KeyStore is on the L1 and a
KeyStoreCache on the L2 mirrors it: `wallet_verification` and
`verify_authorization` read the L1 and add a `cache` block (`cached`,
`revoked`, `expiry`, `fresh`) from the L2 cache, and `grant_session` /
`revoke_session` report the L1 KeyStore write and the cache proof as separate
steps.

One server process serves one chain, so restart with a different `ALTANA_CHAIN` to switch.

## Tools

- **Identity:** `about_altana`
- **Bootstrap:** `create_wallet`
- **Inspect:** `list_wallets`, `wallet_balance`, `wallet_verification`, `verify_authorization`, `list_sessions`
  - `wallet_balance` reads the native balance; pass `tokens` for specific ERC-20s, or `discover: true` to list every token the wallet holds (found through the Altana relay, zero balances omitted, result flagged `discovered: true`). No extra configuration: discovery uses the relay already selected by `ALTANA_CHAIN`.
- **Operate:** `wallet_execute`, `grant_session`, `revoke_session`, `session_execute`
- **Skills:** `search_skills`, `get_skill`

Built on [`@altananetwork/sdk`](https://www.npmjs.com/package/@altananetwork/sdk).
