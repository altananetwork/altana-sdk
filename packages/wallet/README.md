# @altananetwork/sdk

TypeScript SDK for creating non-custodial agentic wallets with on-chain session-key delegation.

```bash
npm install @altananetwork/sdk viem
```

## Quick start

Create a client for the chains you want. Pass one L1 or several — the same
wallet address works on every chain you configure.

```ts
import { createClient, ETHEREUM, BNB } from "@altananetwork/sdk";

// Both L1s, or just one — your choice.
const client = createClient({ chains: [ETHEREUM, BNB] });
```

### Passkey wallet (browser)

```ts
const wallet = await client.createPasskeyWallet({ name: "My Agent Wallet" });
```

### Private-key wallet (server / agent)

```ts
import { signerFromPrivateKey } from "@altananetwork/sdk";

const signer = signerFromPrivateKey(process.env.PRIVATE_KEY);
const wallet = await client.createWallet({ signer });
```

### Grant a session and execute

Operations take an optional `chainId` (defaults to the client's first chain):

```ts
const session = await client.grantSession({
  wallet,
  signer,
  permissions: {
    calls: [{ to: "0x…" }],
    spend: [{ limit: 1_000_000n, period: "day" }], // 1 USDC/day
  },
  expiry: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour
});

await client.execute({
  session,
  chainId: 56, // BNB Smart Chain; omit to use the default chain
  calls: [{ to: "0x…", value: 0n, data: "0x…" }],
});
```

## Documentation

Full docs, concept guides, and SDK reference: [**docs.altana.network**](https://docs.altana.network).

Source: [github.com/altananetwork/sdk](https://github.com/altananetwork/sdk).

## License

GPL-3.0-or-later
