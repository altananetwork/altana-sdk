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
    // receipt.settlement is "confirmed", or "pending" when the transfer was
    // broadcast but its receipt could not be read yet (see below).
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

## When the receipt cannot be read

Settlement broadcasts the transfer, then waits for the receipt (`settleTimeoutMs`,
default 60s). If the broadcast itself fails, nothing happened: the buyer gets a
402 and may pay again. If the broadcast succeeded but the receipt cannot be read
(RPC error, timeout), the payment is **not** treated as failed: the request is
answered 200 with `receipt.settlement === "pending"` and the transaction hash.
Answering with a fresh challenge here would make the buyer sign a second
authorization and pay twice, since every x402 client answers a challenge with a
new nonce.

A pending payment almost always lands. Serve the request and reconcile against
`receipt.txHash` later, or hold delivery yourself until the hash confirms:

```ts
const { response, receipt } = await merchant.guard(req);
if (response) return response;
if (receipt.settlement === "pending") {
  // Not a 402 (no `accepts`): the buyer must not sign a new authorization.
  return Response.json({ status: "pending", tx: receipt.txHash }, { status: 503, headers: { "retry-after": "5" } });
}
```

A buyer that never received its answer can send the same `X-PAYMENT` again: while
the settlement is pending the merchant re-reads the receipt and answers 200
(`confirmed` or still `pending`) with the same hash instead of a replay
rejection. Once confirmed, a replay is refused as before. This bookkeeping is
per process. Behind a load balancer the on-chain nonce still stops a second
transfer, but the rejection reads `settlement failed: ... authorization is
used` rather than `replayed authorization`.

If one facilitator key settles concurrent requests, give it viem's nonce
manager (`privateKeyToAccount(key, { nonceManager })`) so two settlements never
race for the same nonce. To bring your own transports or a custom signer, pass
`clients: { public, wallet }` instead of `rpcUrl`.

## Verified end-to-end

`tests/e2e/fork-x402-server.ts` runs both buyer families against a real
BNB-mainnet fork (genuine $U, USDT and Permit2 bytecode): Studio-envelope
eip3009 settlement, Altana session-key permit2-witness settlement, replay
refusal, and a settlement whose receipt read fails (exactly one transfer lands,
the buyer is never re-challenged). Run it with `bun run fork:x402-server` from
`tests/e2e`; CI runs it on every push.
