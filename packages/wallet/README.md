# @altananetwork/sdk

TypeScript SDK for creating non-custodial agentic wallets with on-chain session-key delegation.

```bash
npm install @altananetwork/sdk viem
```

## Quick start

Create a client for the chains you want. Pass one L1 or several: the same
wallet address works on every chain you configure.

```ts
import { createClient, ETHEREUM, BNB } from "@altananetwork/sdk";

// Both L1s, or just one, your choice.
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

### Pay for an API with x402

A session key can pay for HTTP resources via the x402 standard (Permit2 or EIP-3009
rails), settled on-chain from the smart wallet. Provision once, then pay transparently:

```ts
import { PERMIT2_ADDRESS } from "@altananetwork/sdk";

// One-time, as admin (permit2 rail):
await client.approveTokenForPermit2({ wallet, signer, token: "0xUSDC…" });
await client.approveSignatureChecker({ wallet, signer, session, checker: PERMIT2_ADDRESS });

// The agent pays + fetches (server-side):
const res = await client.fetchWithX402({ session, url: "https://api.example.com/paid" });
```

Payments are authorized with the account's ERC-1271 signature. See
[Off-chain signatures](https://docs.altana.network/concepts/off-chain-signatures).

### Hire another agent (ERC-8183)

Agents can hire and pay each other for work. `hireErc8183Agent` runs the whole
buyer flow (create, register, budget, approve, fund) as one atomic relay
intent, and returns once the job is funded on-chain.

```ts
import { hireErc8183Agent, getErc8183Job, BNB } from "@altananetwork/sdk";

const { jobId } = await hireErc8183Agent(session, {
  provider: "0xSellerAgentAddress",
  task: "Audit wallet 0x…'s Venus position and recommend an action.",
  budget: 100_000_000_000_000_000n, // 0.1 $U (18 decimals)
}, { network: BNB });

const job = await getErc8183Job(BNB, jobId); // OPEN, FUNDED, SUBMITTED, COMPLETED
```

The admin path is `hireErc8183Agent(wallet, signer, params, opts)`. Using the
session path instead means a scoped key with an on-chain spend limit caps what
an autonomous agent can ever escrow. `settleErc8183Job` approves or disputes on
delivery, and `buildClaimRefundCall` recovers the budget if nothing arrives.

Full reference: [ERC-8183 agent jobs](https://docs.altana.network/sdk/erc8183).

## Documentation

Full docs, concept guides, and SDK reference: [**docs.altana.network**](https://docs.altana.network).

Source: [github.com/altananetwork/altana-sdk](https://github.com/altananetwork/altana-sdk).

## License

Apache-2.0
