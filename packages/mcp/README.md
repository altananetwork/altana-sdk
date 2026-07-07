# @altananetwork/mcp

MCP server that lets AI hosts (Claude Code, Claude Desktop, Cursor, Continue, any MCP
client) operate [Altana](https://altana.network) agentic wallets — creating wallets, granting
scoped session keys, executing transactions, and verifying authority on-chain — **without
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
| `bnb` (default) | BNB Smart Chain (56) | Altana hosted (`https://relay.altana.network`) |
| `ethereum` | Ethereum (1) | Altana relay (`https://relay.altana.network`) |

```bash
# Operate on Ethereum instead of the BNB default
ALTANA_CHAIN=ethereum bunx @altananetwork/mcp
```

One server process serves one chain — restart with a different `ALTANA_CHAIN` to switch.

## Tools

- **Identity:** `about_altana`
- **Bootstrap:** `create_wallet`
- **Inspect:** `list_wallets`, `wallet_balance`, `wallet_verification`, `verify_authorization`, `list_sessions`
- **Operate:** `wallet_execute`, `grant_session`, `revoke_session`, `session_execute`

Built on [`@altananetwork/sdk`](https://www.npmjs.com/package/@altananetwork/sdk).
