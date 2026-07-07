# Altana

Non-custodial agentic wallets with on-chain session-key delegation.

Altana enables a **global registry of permissions on-chain, accessible by any agent**. Traditional agentic wallets store permissions locally or in centralized servers. Altana's **KeyStore** infrastructure makes composable permissions accessible across any chain and any wallet, enabling:

- **Agent-to-agent verification.** Two AIs acting on the same wallet can verify each other's authority on-chain. No platform in between.
- **Cross-app authorization.** Any DEX, orderbook, or protocol can read whether an agent is authorized, without integrating with the specific wallet vendor.
- **A new class of agent services.** Users hire AI agents through on-chain employment contracts. Anyone can verify what an agent is allowed to do, and revoke is one transaction.

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

The session is **on-chain in KeyStore** the moment `grantSession` confirms. Any tool can verify the authorization without going through Altana.

## Packages

- [`@altananetwork/sdk`](./packages/wallet) — TypeScript SDK for creating wallets, granting sessions, and executing transactions.
- [`@altananetwork/mcp`](./packages/mcp) — MCP server that lets AI hosts (Claude, Cursor, Continue) operate Altana wallets via tools and slash commands.

## Documentation

Full docs, guides, and SDK reference: **[docs.altana.network](https://docs.altana.network/)**.

- Getting started: [create an agentic wallet](https://docs.altana.network/getting-started/create-agentic-wallet) (passkey or private key), [connect an AI tool](https://docs.altana.network/getting-started/build-with-claude)
- Concepts: [KeyStore](https://docs.altana.network/concepts/keystore), [sessions](https://docs.altana.network/concepts/sessions), [how Altana compares](https://docs.altana.network/concepts/comparison)
- SDK reference: [`createWallet`](https://docs.altana.network/sdk/create-wallet), [`createPasskeyWallet`](https://docs.altana.network/sdk/create-passkey-wallet), [`grantSession`](https://docs.altana.network/sdk/grant-session), [`execute`](https://docs.altana.network/sdk/execute), [`revokeSession`](https://docs.altana.network/sdk/revoke-session), [`recoverFromPasskey`](https://docs.altana.network/sdk/recover-from-passkey)
- MCP server: [overview](https://docs.altana.network/mcp), [install](https://docs.altana.network/mcp/install), [tools](https://docs.altana.network/mcp/tools)

## Issues and feedback

Found a bug, have a feature request, or want to discuss something? Open an issue on [GitHub Issues](https://github.com/altananetwork/sdk/issues).

## License

[GPL-3.0](./LICENSE)
