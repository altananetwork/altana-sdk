---
name: altana-agentic-wallet
description: Use when building agents, bots, or apps that need non-custodial wallets with on-chain session-key delegation. Triggers on requests involving agent wallets, scoped permissions, session keys, programmatic spending, passkey wallets, cross-agent authorization checks, or "an AI that can act on my wallet". The SDK lives at @altananetwork/sdk; this skill teaches how to wire it.
---

# Altana Agentic Wallet

Altana gives apps non-custodial smart-account wallets and a **public, on-chain registry of who is authorized to act on each wallet**. Permissions are first-class on-chain objects — any agent, app, or chain can verify them; no platform sits in the middle.

The wallet's admin key signs once to grant a scoped session; the session signs every action after. Revocation is one tx, effective immediately.

## When to reach for this skill

Recognize these patterns:

- "I want an AI agent that can trade / pay / mint on my behalf"
- "Grant this bot a $50/day spending limit on USDC"
- "How do two agents verify each other on-chain"
- "Build a wallet that recovers from a passkey"
- "Non-custodial wallet for my app, but I don't want users to handle seed phrases"
- "Revoke this key — make sure it can't sign anymore"
- "Check whether <address> is allowed to act on <wallet> right now"

If the user is operating an existing wallet from Claude itself (one-off transactions, granting sessions to other agents), prefer the **MCP server** (`@altananetwork/mcp`) — it exposes the SDK as tools/slash commands. If the user is **writing code** that uses Altana, use this SDK directly.

## The SDK: a client and its methods

Everything goes through a client. Create one with `createClient`, configured with the chains it should support, then call its methods.

```ts
import { createClient, BNB, ETHEREUM, BASE } from "@altananetwork/sdk";

const client = createClient({ chains: [BNB] });
// Wallet execution: BNB (default) or ETHEREUM.
// Cross-chain verification cache: BASE.
// client.createWallet        — smart account from a local private key (CLI, script, agent)
// client.createPasskeyWallet — smart account from a passkey (Face ID / Touch ID), browser
// client.execute             — run calls as wallet admin OR as a session
// client.grantSession        — admin authorizes a scoped session key on-chain
// client.revokeSession       — admin pulls authority; effect is immediate
// client.recoverFromPasskey  — browser: rebuild wallet handle from any saved passkey
// client.balances            — read native + token balances for a wallet
// client.fetchWithX402       — pay for an HTTP resource with a session key (x402)
// client.signOrder           — session-key ERC-1271 signature over any digest (offline)
// client.approveSignatureChecker — authorize who may verify a session's signatures
// client.approveTokenForPermit2  — one-time ERC20 approve(Permit2) for the permit2 x402 rail
```

The private key lives wherever your code runs — your laptop, your agent's process, an OS keychain. **Altana never sees it.** Custody is local to the integrator.

The same wallet address is provisioned on every chain the client lists. `client.execute` accepts either an admin pair (`wallet` + `signer`) or a `session`, plus the `calls`; pass `chainId` to pick a chain (defaults to the client's first).

## Workflows

### Local wallet from a private key

```ts
import { createClient, BNB, signerFromPrivateKey } from "@altananetwork/sdk";

const client = createClient({ chains: [BNB] });

// Key is read from wherever your code keeps it — env var, OS keychain,
// encrypted file. It never leaves the process.
const signer = signerFromPrivateKey(process.env.AGENT_PRIVATE_KEY as `0x${string}`);
const wallet = await client.createWallet({ signer });

// Send 0.001 BNB. First execute also registers the admin key in Keystore —
// happens transparently inside the same userOp.
const result = await client.execute({
  wallet,
  signer,
  calls: { to: "0xRecipient...", value: 1_000_000_000_000_000n }, // 0.001 BNB in wei
});
console.log(result.status, result.transactionHash);
```

### Browser wallet with passkey

```ts
import { createClient, BNB } from "@altananetwork/sdk";

const client = createClient({ chains: [BNB] });
const wallet = await client.createPasskeyWallet({ name: "MyApp", rpId: "myapp.example" });
// `wallet.signer` is the PasskeySigner — used the same way as any other signer.
```

### Grant a session to an agent

```ts
const session = await client.grantSession({
  wallet,
  signer: adminSigner,
  permissions: {
    calls: [{ to: "0xUniswapRouter..." }],          // only this contract
    spend: [{
      limit: 100_000_000n,                          // 100 USDC (6 decimals)
      period: "day",
      token: "0xUSDC...",
    }],
  },
  expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60, // 7 days
});

// Hand `session` to whichever process runs the agent. Persist these fields:
//   walletAddress, publicKey, permissions, expiry, and the signer's private key
// (signer.export() if your signer is a private-key signer). The agent needs
// the exact permissions+expiry at execute time — the on-chain validator
// matches them byte-for-byte against the authorization committed at grant.
```

### Agent acts using a session

```ts
const result = await client.execute({
  session,
  calls: [{ to: "0xUniswapRouter...", data: "0x...", value: 0n }],
});
```

### Agent pays for an HTTP resource (x402)

A session key can pay for paid APIs via the x402 standard. Provision the rail once
(as admin), then the agent pays transparently. `fetchWithX402` signs an ERC-1271
payment authorization and retries the request with an `X-PAYMENT` header.

```ts
import { PERMIT2_ADDRESS } from "@altananetwork/sdk";

// One-time, as admin — permit2 rail (any Permit2-approved token, incl. Binance B402):
await client.approveTokenForPermit2({ wallet, signer: adminSigner, token: "0xUSDC..." });
await client.approveSignatureChecker({ wallet, signer: adminSigner, session, checker: PERMIT2_ADDRESS });
// EIP-3009 rail instead? The checker is the token: approveSignatureChecker({ ..., checker: "0xUSDC..." })

// The agent pays + fetches:
const res = await client.fetchWithX402({ session, url: "https://api.example.com/paid" });
console.log(res.status, await res.text());
```

Run this server-side: third-party x402 endpoints often omit `X-PAYMENT` from CORS, so
browsers can't POST the payment. The signature is a smart-account (ERC-1271) signature —
a facilitator must verify via `isValidSignature`, not `ecrecover`.

### Verify any key on-chain (from any tool)

```ts
import { createPublicClient, http, keccak256 } from "viem";
import { mainnet } from "viem/chains";
import { ETHEREUM } from "@altananetwork/sdk";

const publicClient = createPublicClient({ chain: mainnet, transport: http() });
const KEYSTORE_ABI = [{
  name: "getActiveKeys", type: "function", stateMutability: "view",
  inputs: [{ name: "user", type: "address" }],
  outputs: [{ type: "bytes32[]" }],
}] as const;

const active = await publicClient.readContract({
  address: ETHEREUM.keyStore,
  abi: KEYSTORE_ABI,
  functionName: "getActiveKeys",
  args: [walletAddress],
});
const authorized = active.includes(keccak256(sessionPublicKey));
```

This is the killer feature: a wallet that has never heard of your app can still verify whether a given key is authorized. No vendor lock-in.

### Revoke a session

```ts
await client.revokeSession({ wallet, signer: adminSigner, session });
// or, if you only kept the public key:
await client.revokeSession({ wallet, signer: adminSigner, session: sessionPublicKey });
```

Revocation revokes the key in Keystore **and** pulls the session's on-chain authority in the same userOp. The session's next signed call reverts at validation. Revocation is monotonic in Keystore v1.0.0 — to restore access, grant a fresh session.

### Recover a passkey wallet

```ts
const wallet = await client.recoverFromPasskey({ rpId: "myapp.example" });
// Browser shows the passkey picker; user picks one, biometric prompt, done.
// Two on-chain reads, no server, no localStorage required.
```

## When to use the MCP server vs the SDK directly

| You are… | Use |
|---|---|
| Writing TypeScript/JS code that needs wallet ops | `@altananetwork/sdk` (this SDK) |
| Operating wallets interactively from Claude Code | `@altananetwork/mcp` server, tools like `create_wallet`, `grant_session` |
| Building a UI that signs from the browser | `@altananetwork/sdk` with `client.createPasskeyWallet` |
| Running a local agent that holds its own session | `@altananetwork/sdk` with `client.execute({ session, calls })` |

The MCP server is a thin wrapper around this SDK — anything the MCP does, you can do directly with the SDK.

## Notes

- **Funding.** Fund `wallet.address` with native tokens before the first `execute`. On Ethereum, send ETH from your own wallet or an exchange. On BNB, send BNB from your own wallet or an exchange.
- **First execute registers the admin.** The Keystore `initialRegisterKey` is auto-prepended on the wallet's first admin-signed action. Don't pre-call it. The wallet is "live" but not on-chain until that first tx.
- **Sessions must be byte-exact on execute.** The on-chain validator matches `permissions + expiry + role + publicKey` exactly to the hash committed at grant time. Re-serializing through a sloppy JSON path (bigints → number, period reordering) breaks the match. Persist the `Session` object verbatim or reconstruct it identically.
- **Empty calls means no calls.** `client.execute({ wallet, signer, calls: [] })` is rejected. Pass at least one call.
- **`permissions.calls` omitted = unrestricted.** If you don't pass `calls`, the session can call any contract within its spend cap. Set both unless that's truly what you want.
- **Pick chains at the client.** `createClient({ chains })` takes one or more chains; the same wallet address works on all of them. Select per operation with `chainId`.

## Networks

```ts
import { ETHEREUM, BNB, BASE } from "@altananetwork/sdk";
// ETHEREUM      — Ethereum (chain 1), L1 Keystore source of truth
// BNB  — BNB Smart Chain (chain 56)
// BASE — Base (chain 8453), L2 Keystore cache
//
// ETHEREUM.keyStore           = 0xb70fDa90C1d576Ba8399946a0c10ECD9d9Ea923b
// ETHEREUM.keyStoreController = 0x30a188Eecf14F4142B0d828ce838C9E1134e7FaA
```

## What never changes

- Altana never sees the private key. Custody follows the signer the integrator brings.
- Every authorization is on-chain in Keystore — readable by any tool, on any chain that bridges to it.
- Revoke is one tx, immediate.
