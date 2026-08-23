# @altananetwork/x402-server

Seller-side x402/B402 payments for agents that charge per request.

Put `guard()` in front of any HTTP route and it becomes a paid capability:
unpaid requests get a 402 challenge; requests carrying a valid `X-PAYMENT`
header are settled **on-chain, immediately** and passed through.

Payable out of the box by:

- **BNB Agent Studio agents** (`bag x402 trust <your-url>` → `bag x402 buy`).
  They sign EIP-3009 `TransferWithAuthorization` on $U (United Stables).
- **Altana SDK agents** (`fetchWithX402` / the MCP `x402_request` tool):
  smart-account session keys signing the B402 permit2-exact rail (ERC-1271).
- Anything else speaking the B402 v2 wire (CAIP-2 networks, `scheme:"exact"`,
  `extra.assetTransferMethod`).

## Usage

```ts
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { createX402Merchant, U_TOKEN, USDT_BSC } from "@altananetwork/x402-server";

const merchant = createX402Merchant({
  chainId: 56,
  payTo: "0xYourAltanaSmartAccount",          // where earnings land
  price: 200_000_000_000_000_000n,            // 0.2 per call (18 dec)
  minPrice: 50_000_000_000_000_000n,          // clamp floor
  maxPrice: 2_000_000_000_000_000_000n,       // clamp ceiling
  rails: [
    { rail: "eip3009", token: U_TOKEN[56] },  // Studio buyers
    { rail: "permit2-exact", token: USDT_BSC, spender: facilitator.address }, // Altana/B402 buyers
  ],
  resource: "https://api.example.com/audit",
  facilitator: privateKeyToAccount(process.env.FACILITATOR_KEY),  // settler EOA (gas only)
  rpcUrl: "https://bsc-dataseed.binance.org",
  chain: bsc,
});

Bun.serve({
  port: 8080,
  async fetch(req) {
    const { response, receipt } = await merchant.guard(req);
    if (response) return response;             // 402 (challenge or rejection)
    return Response.json({ data: await doTheWork(), tx: receipt.txHash });
  },
});
```

## How settlement works

| Rail | Buyer signs | Settled via | Verified by |
| --- | --- | --- | --- |
| `eip3009` | `TransferWithAuthorization` ($U) | `token.transferWithAuthorization(bytes)` | the token contract |
| `permit2-exact` | `PermitWitnessTransferFrom` (any Permit2-approved token) | `Permit2.permitWitnessTransferFrom` | Permit2 |

The facilitator account only broadcasts and pays gas. Funds move directly
from the payer to `payTo`. The recipient is **bound into the buyer's
signature** (EIP-3009 `to` / the permit2 `Witness`), so a compromised
facilitator key cannot redirect earnings.

Off-chain checks run first (token, amount within `[minPrice, maxPrice]`,
recipient, expiry, signature). Checker-restricted smart accounts (Altana
session keys answer `isValidSignature` only to their approved checker) defer
the signature check to the settling contract, so an invalid signature reverts
the settlement and the request is refused. Replay is impossible: EIP-3009
nonces and the Permit2 nonce bitmap burn on-chain.

## Verified end-to-end

`tests/e2e/fork-x402-server.ts` runs both buyer families against a real
BNB-mainnet fork (genuine $U, USDT and Permit2 bytecode): Studio-envelope
eip3009 settlement, Altana session-key permit2-witness settlement, and replay
refusal. Run it with `bun run fork:x402-server` from `tests/e2e`.

## Casper Network (CEP-18)

`createCasperX402Merchant` is the same shape as `createX402Merchant`
(`challengeBody` / `requirePayment` / `guard`) for `casper:casper` and
`casper:casper-test`, settling a CEP-18 token such as wCSPR.

```ts
import { createCasperX402Merchant, CASPER_TESTNET } from "@altananetwork/x402-server";

const merchant = createCasperX402Merchant({
  network: CASPER_TESTNET,
  payTo: "00...",                 // Casper account hash
  price: 10_000n,
  token: { asset: "9824...", name: "Wrapped CSPR", version: "1", symbol: "wCSPR", decimals: 9 },
  facilitator: { accessToken: process.env.CSPR_CLOUD_TOKEN },
});
```

Casper is not EVM — accounts are ed25519/secp256k1 keys and 32-byte account
hashes, and payments settle as Casper transactions, not calldata — so verify
and settle are delegated over HTTP to an x402 facilitator for Casper
(CSPR.cloud runs one at `https://x402-facilitator.cspr.cloud`, the default).
Your server needs no Casper node connectivity and holds no Casper key. The
EVM rails above are unaffected: the Casper rail is a separate module with its
own types.
