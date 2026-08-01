# Altana

**Let your AI agents pay, invest, and operate. Safely.**

Altana is noncustodial infrastructure that gives your agents real authority to transact, always inside limits you set and can revoke at any moment. Three pieces make it work: an agentic wallet your agent acts from, the **KeyStore** permission registry that records exactly what each agent may do, and an intent relay that turns an approved intent into a real onchain transaction with gas handled for you.

Every permission lives in a neutral onchain registry: openly verifiable, revocable in one transaction, and accessible by any agent on any chain. That unlocks:

- **Agent-to-agent verification.** Two agents acting on the same wallet can verify each other's authority onchain. No platform in between.
- **Cross-app authorization.** Any DEX, orderbook, or protocol can read whether an agent is authorized, without integrating a specific wallet vendor.
- **Instant revocation.** Change your mind at any point. Revoke a key in one transaction, and it takes effect before the next action.

Live on mainnet across BNB Chain, Ethereum, and Base.

## Install

```bash
npm install @altananetwork/sdk viem
```

## Quick start

Create a client for the chains you want, then create a wallet on it. The same smart account address works on every chain you configure.

```ts
import { createClient, BNB } from "@altananetwork/sdk";

const client = createClient({ chains: [BNB] });
```

**For end-user apps (browser):** Passkey wallet, secured by Face ID or Touch ID. No seed phrase, no extension.

```ts
const wallet = await client.createPasskeyWallet({
  name: "MyApp",
  rpId: "myapp.example",
});
```

**For agents and scripts:** Private-key wallet. Bring your own key from env, OS keychain, or hardware wallet.

```ts
import { signerFromPrivateKey } from "@altananetwork/sdk";

const signer = signerFromPrivateKey(process.env.PRIVATE_KEY as `0x${string}`);
const wallet = await client.createWallet({ signer });
```

Both return the same wallet handle, and every client method works with either.

### Grant a scoped session

```ts
const session = await client.grantSession({
  wallet,
  signer: wallet.signer,
  permissions: {
    calls: [{ to: "0xUniswapRouter..." }],
    spend: [{ limit: 100_000_000n, period: "day", token: "0xUSDC..." }],
  },
  expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
});

// The agent uses the session directly. Admin not involved.
await client.execute({
  session,
  calls: [{ to: "0xUniswapRouter...", data: "0x...", value: 0n }],
});
```

By default the session is **on-chain in KeyStore** the moment `grantSession` confirms, so any tool can verify the authorization without going through Altana. (`register: false` grants an unlisted session for ephemeral keys; register it later with `registerSessionKey`.)

## What else the SDK does

Beyond wallets and sessions, `@altananetwork/sdk` also covers:

- **[Paying for APIs with x402](https://docs.altana.network/sdk/x402).** A session key pays per request over the x402 standard, on the Permit2 or EIP-3009 rail, settled onchain from the smart wallet.
- **[Hiring and settling agent jobs (ERC-8183)](https://docs.altana.network/sdk/erc8183).** Hire another agent, track job status, claim a refund, and settle on delivery.
- **[Off-chain order signing](https://docs.altana.network/sdk/sign-order).** Session keys sign ERC-1271 authorizations that any contract can verify.
- **[Reading balances](https://docs.altana.network/sdk/balances)**, including BEP-677 scaled-UI-amount tokens.
- **[Syncing a key to an L2](https://docs.altana.network/sdk/sync-to-l2).** Prove KeyStore state to an OP Stack L2 so it can read the key without an L1 call.
- **[BNB testnet](https://docs.altana.network/sdk/bnb-testnet)**, with a faucet helper for funding test accounts.

## Packages

- [`@altananetwork/sdk`](./packages/wallet): TypeScript SDK for creating wallets, granting sessions, and executing transactions.
- [`@altananetwork/mcp`](./packages/mcp): MCP server that lets AI hosts (Claude, Cursor, Continue) operate Altana wallets via tools and slash commands.
- [`@altananetwork/x402-server`](./packages/x402-server): the seller side of x402. Issue 402 challenges, verify `X-PAYMENT` headers (EOA and ERC-1271), and settle onchain, for agents charging per request.
- [`@altananetwork/hypersigner-keystore-mcp`](./packages/hypersigner-keystore-mcp): non-custodial MCP server for KeyStore authorization. It verifies, registers, timeboxes and revokes keys without ever holding a key or signing anything, so any agent runtime can check authority.

## Documentation

Full docs, guides, and SDK reference: **[docs.altana.network](https://docs.altana.network/)**.

- Getting started: [create an agentic wallet](https://docs.altana.network/getting-started/create-agentic-wallet) (passkey or private key), [connect an AI tool](https://docs.altana.network/getting-started/build-with-claude)
- Concepts: [KeyStore](https://docs.altana.network/concepts/keystore), [sessions](https://docs.altana.network/concepts/sessions), [how Altana compares](https://docs.altana.network/concepts/comparison)
- SDK reference: [`createWallet`](https://docs.altana.network/sdk/create-wallet), [`createPasskeyWallet`](https://docs.altana.network/sdk/create-passkey-wallet), [`grantSession`](https://docs.altana.network/sdk/grant-session), [`execute`](https://docs.altana.network/sdk/execute), [`revokeSession`](https://docs.altana.network/sdk/revoke-session), [`recoverFromPasskey`](https://docs.altana.network/sdk/recover-from-passkey), [`balances`](https://docs.altana.network/sdk/balances)
- Payments and jobs: [x402 (buyer)](https://docs.altana.network/sdk/x402), [x402 (seller)](https://docs.altana.network/sdk/x402-server), [ERC-8183 agent jobs](https://docs.altana.network/sdk/erc8183), [order signing](https://docs.altana.network/sdk/sign-order)
- MCP server: [overview](https://docs.altana.network/mcp), [install](https://docs.altana.network/mcp/install), [tools](https://docs.altana.network/mcp/tools)

## Issues and feedback

Found a bug, have a feature request, or want to discuss something? Open an issue on [GitHub Issues](https://github.com/altananetwork/altana-sdk/issues).

## License

[GPL-3.0](./LICENSE)
