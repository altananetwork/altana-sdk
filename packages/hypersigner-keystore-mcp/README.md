# @altananetwork/hypersigner-keystore-mcp

Non-custodial MCP server for KeyStore agent authorization.

`@altananetwork/hypersigner-keystore-mcp` lets **any agent SDK** verify agent-to-agent authority, and lets agent SDKs and tools register, timebox, and revoke agent authority through the Altana KeyStore registry. It never holds private keys, signs transactions, or broadcasts transactions. Read tools query on-chain state; encode tools return unsigned `{ to, value, data, chainId }` calls for your wallet or SDK to sign.

## Use Cases

- Agent-to-agent verification before payment, work dispatch, or data handoff.
- Time-boxed authority for short-lived agent sessions that expire automatically.
- Cross-service kill-switches where one revoke blocks an agent everywhere.
- Neutral authorization checks for Trust Wallet Agent Kit, Coinbase AgentKit, LangChain agents, custom agent SDKs, and other agent runtimes.
- Unsigned transaction encoding so the user's wallet or SDK remains the only signer.

## Install

```sh
bunx @altananetwork/hypersigner-keystore-mcp
```

For local development:

```sh
bun install
bun run start
```

## MCP Config

Use stdio transport:

```json
{
  "mcpServers": {
    "keystore": {
      "command": "bunx",
      "args": ["@altananetwork/hypersigner-keystore-mcp"],
      "env": {
        "ALTANA_CHAIN": "bnb"
      }
    }
  }
}
```

Optional env vars:

- `ALTANA_CHAIN`: `bnb`, `bsc`, `56`, `ethereum`, `eth`, or `1`. Defaults to `bnb`.
- `RPC_URL`: override the default public RPC URL.

## Tools

- `keystore_verify_authorization`
  - Reads `isValidKey(user, keyId)`.
  - Returns whether the key is registered, not revoked, and not expired.

- `keystore_list_active_keys`
  - Lists active key IDs for a user and expands each record with liveness, expiry, role, and public key.

- `keystore_get_key`
  - Reads a single on-chain key record.

- `keystore_registration_quote`
  - Reads the current one-time registration fee in native wei.

- `keystore_encode_register_key`
  - Returns unsigned calldata to register a root or session key.
  - Session keys may include an `expiry` timestamp for time-boxed authority.

- `keystore_encode_revoke_key`
  - Returns unsigned calldata to revoke a key.
  - Revocation must be signed by the user account.

## Safety Model

This server is intentionally not a wallet.

- It does not accept private keys.
- It refuses 32-byte values passed as `publicKey`, because those often indicate private-key leakage.
- It does not sign or send transactions.
- It does not custody funds.
- It only reads the KeyStore and encodes calls that another wallet or SDK signs.

## Example Flow

1. An Agent SDK creates an agent keypair.
2. The SDK calls `keystore_encode_register_key` with the agent public key.
3. The user wallet signs and sends the returned transaction.
4. A counterparty calls `keystore_verify_authorization` before serving the agent.
5. The user can later call `keystore_encode_revoke_key`; once signed and sent, all readers see the key as invalid.

## Programmatic Helpers

The package also exports typed helpers:

```ts
import {
  buildRegisterCall,
  buildRevokeCall,
  deriveKeyId,
  readIsValidKey,
  resolveChain,
} from "@altananetwork/hypersigner-keystore-mcp/keystore";
```

## License

GPL-3.0-or-later.
