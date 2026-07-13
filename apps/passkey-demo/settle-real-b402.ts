/**
 * REAL end-to-end B402 settlement from a headless Altana wallet on BNB.
 *
 *   bun run settle-real-b402         (run once → prints an address to fund)
 *   <send USDC + a little BNB to that address>
 *   bun run settle-real-b402         (run again → provisions + pays for real)
 *
 * Resumable: state (admin key, session key, wallet address, step flags) is
 * persisted to .b402-state.json so you can fund between runs. The script:
 *   1. Creates/loads a headless Altana wallet (private-key admin) on BNB.
 *   2. Waits until it holds enough USDC.
 *   3. Grants a scoped SESSION key, approve(Permit2) on USDC, and approves
 *      Permit2 as the session's ERC-1271 signature checker — the exact
 *      provisioning permit2-exact settlement needs.
 *   4. Pays a REAL Binance-facilitated B402 endpoint (CoinMarketCap) with
 *      fetchWithX402 and verifies the USDC actually left the wallet.
 *
 * This is the definitive test of whether Binance's real facilitator settles an
 * Altana smart-account (ERC-1271) payment end-to-end.
 */

import {
  createClient,
  BNB,
  signerFromPrivateKey,
  fetchWithX402,
  PERMIT2_ADDRESS,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  http,
  formatEther,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { generatePrivateKey } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const STATE_FILE = ".b402-state.json";
const USDC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"; // Binance-Peg USDC, 18 dec
const PAY_URL = "https://pro-api.coinmarketcap.com/x402/v1/dex/search?q=bnb";
const NEED_USDC = parseUnits("0.05", 18); // payment is 0.01; leave headroom
const FEE_TOKEN = process.env.B402_FEE_TOKEN as Address | undefined; // default: native BNB

const ERC20 = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

type State = {
  adminKey: Hex;
  sessionKey: Hex;
  walletAddress?: Address;
  sessionExpiry?: number;
  flags: { granted?: boolean; permit2Approved?: boolean; checkerApproved?: boolean };
};

function loadState(): State {
  if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  const s: State = { adminKey: generatePrivateKey(), sessionKey: generatePrivateKey(), flags: {} };
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  return s;
}
function saveState(s: State) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

const pub = createPublicClient({ chain: bsc, transport: http(BNB.publicRpcUrl) });
const usdc = (v: bigint) => `${formatUnits(v, 18)} USDC`;

async function main() {
  const state = loadState();
  const admin = signerFromPrivateKey(state.adminKey);
  const sessionSigner = signerFromPrivateKey(state.sessionKey);
  const client = createClient({ chains: [BNB] });

  // 1. Wallet (deterministic address from the admin key).
  const wallet = await client.createWallet({ signer: admin });
  state.walletAddress = wallet.address;
  saveState(state);
  console.log(`\nAltana wallet (BNB): ${wallet.address}`);

  // 2. Funding gate.
  const [bnbBal, usdcBal] = await Promise.all([
    pub.getBalance({ address: wallet.address }),
    pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [wallet.address] }),
  ]);
  console.log(`  BNB (relay fees): ${formatEther(bnbBal)}   USDC: ${formatUnits(usdcBal, 18)}`);

  if (usdcBal < NEED_USDC || bnbBal === 0n) {
    console.log(
      `\n▸ FUND THIS ADDRESS, then re-run \`bun run settle-real-b402\`:\n` +
        `    • ${usdc(NEED_USDC)}  (token ${USDC})\n` +
        `    • ~0.01 BNB           (relay fees for 3 admin txns)\n` +
        `  Both on BNB Smart Chain (chainId 56). The payment itself is 0.01 USDC.`,
    );
    return;
  }

  // 3. Provision. Rebuild the Session object locally each run; only hit the
  //    chain for steps not yet done.
  const expiry = state.sessionExpiry ?? Math.floor(Date.now() / 1000) + 24 * 3600;
  const permissions = {
    calls: [{ to: USDC }],
    spend: [{ limit: parseUnits("1", 18), period: "day" as const }],
  };

  if (!state.flags.granted) {
    console.log("\n▸ Granting session key (delegates the wallet + registers the key)…");
    await client.grantSession({ wallet, signer: admin, sessionSigner, permissions, expiry });
    state.flags.granted = true;
    state.sessionExpiry = expiry;
    saveState(state);
  }
  const session: Session = {
    walletAddress: wallet.address,
    signer: sessionSigner,
    publicKey: sessionSigner.publicKey,
    permissions,
    expiry: state.sessionExpiry ?? expiry,
  };

  const allowance = await pub.readContract({
    address: USDC, abi: ERC20, functionName: "allowance", args: [wallet.address, PERMIT2_ADDRESS],
  });
  if (allowance < NEED_USDC) {
    console.log("▸ approve(Permit2) on USDC…");
    await client.approveTokenForPermit2({ wallet, signer: admin, token: USDC, chainId: 56, ...(FEE_TOKEN ? { feeToken: FEE_TOKEN } : {}) });
    state.flags.permit2Approved = true;
    saveState(state);
  }

  if (!state.flags.checkerApproved) {
    console.log("▸ approve Permit2 as the session's ERC-1271 signature checker…");
    await client.approveSignatureChecker({ wallet, signer: admin, session, checker: PERMIT2_ADDRESS, chainId: 56, ...(FEE_TOKEN ? { feeToken: FEE_TOKEN } : {}) });
    state.flags.checkerApproved = true;
    saveState(state);
  }

  // 4. Pay a REAL B402 endpoint and verify the money moved.
  console.log(`\n▸ Paying REAL B402 service: ${PAY_URL}`);
  const before = await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [wallet.address] });

  const res = await fetchWithX402(session, PAY_URL, undefined, { chainId: 56 });
  const text = await res.text();
  console.log(`  ← HTTP ${res.status}`);
  console.log(`  ← body: ${text.slice(0, 400)}`);

  const after = await pub.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [wallet.address] });
  const spent = before - after;

  if (res.status === 200 && spent > 0n) {
    console.log(`\n✓ REAL PAYMENT SETTLED. Wallet spent ${usdc(spent)} on-chain via Permit2.`);
  } else if (res.status === 200) {
    console.log(`\n✓ HTTP 200 received (spent ${usdc(spent)}).`);
  } else {
    let err: string | undefined;
    try { err = JSON.parse(text).error; } catch {}
    console.log(`\n· Not settled (HTTP ${res.status}${err ? `, "${err}"` : ""}). USDC delta: ${usdc(spent)}.`);
  }
}

main().catch((e) => {
  console.error("\n✗ error:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
