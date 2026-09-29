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

- `ALTANA_CHAIN`: `bnb`, `bsc`, `56`, `ethereum`, `eth`, `1`, `bnb-testnet`, `97`, `sepolia`, `11155111`. Defaults to `bnb`. L2 aliases resolve to the L1 that holds the KeyStore *and* name the L2's cache: `celo` / `42220` to `ethereum`, `celo-sepolia` / `11142220` to `sepolia`. Every encoded call carries the `chainId` to sign it on: registry calls the L1's, the cache proof the L2's. See [Reaching an L2: Celo](#reaching-an-l2-celo).
- `RPC_URL`: override the default registry RPC URL.
- `L2_RPC_URL`: override the L2 read RPC URL, when `ALTANA_CHAIN` names an L2.

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

- `keystore_cache_status`
  - Reads the L2 KeyStoreCache: is this key valid on the L2 right now?
  - Says which state the entry is in (never proven, proven at the anchored block, proven at an earlier one) and which L1 block the L2 anchors.
  - Set `ALTANA_CHAIN` to an L2 alias (`celo`, `celo-sepolia`).

- `keystore_encode_cache_proof`
  - Returns unsigned calldata for the L2 cache's `populateKey`: the proof that carries the key's current L1 state to the L2.
  - Permissionless: sign and send it from any funded L2 account, not necessarily the user's.

## Reaching an L2: Celo

An L2 keeps its KeyStore on the L1. Celo's wallets are authorized in the
Ethereum registry, Celo Sepolia's in the Sepolia one, and read on the L2 through
a `KeyStoreCacheOPStack`, which answers `isValidKey` with one `eth_call`.

The cache holds what has been proven into it. A `populateKey` call carries a
key's L1 state across — an authorization, a new expiry or a revocation alike —
by proving the KeyStore's storage against the L1 block the L2's `L1Block`
predeploy anchors. So the L2 follows the L1 one proof at a time, and until the
next proof lands it answers with the state it was last given. Relaying is
permissionless: any funded L2 account may relay a proof for any user, and the
relayer gains nothing and can change nothing.

The L2 anchors the L1 with a lag, and a proof can only carry what the anchored
block already holds. On Celo Sepolia the predeploy advances roughly every 20
minutes and trails Sepolia by 15 to 20, so an L1 write becomes provable about
half an hour after it lands. `keystore_cache_status` returns the anchored block
as `anchor.number`; compare it with the block holding the write.

Set `ALTANA_CHAIN` to the L2. It resolves to the registry that holds the
KeyStore *and* names the mirror:

| `ALTANA_CHAIN` | Registry (sign registry calls here) | Cache (sign the proof here) |
| --- | --- | --- |
| `celo`, `42220` | Ethereum, chain 1 | Celo, chain 42220 |
| `celo-sepolia`, `11142220` | Sepolia, chain 11155111 | Celo Sepolia, chain 11142220 |

Naming the registry chain itself (`ethereum`, `sepolia`) resolves to the same
registry with no mirror: more than one L2 is rooted in each, so nothing would
say which cache a proof is meant for. `L2_RPC_URL` overrides the L2 read RPC, as
`RPC_URL` does for the registry.

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

On an L2, steps 3 and 5 each carry on with one more call:
`keystore_encode_cache_proof`, signed and sent on the L2, takes the new state to
the cache, and readers there see it from then on.

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

// The L2 cache, same shape: reads and unsigned calls.
import { encodeCacheProof, readCacheStatus } from "@altananetwork/hypersigner-keystore-mcp/cache";
```

`./keystore` needs nothing but viem. `./cache` borrows the SDK's proof builder
rather than keeping a second copy of the KeyStore's storage layout, because a
proof built against the wrong slot does not fail loudly: it proves the value of
another word.

## License

Apache-2.0.
