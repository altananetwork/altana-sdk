/**
 * LIVE (BSC MAINNET): pay a real B402 Bazaar merchant from Doris's wallet.
 *
 *   1. Grant a scoped session key (spend-limited to $U) via the relay.
 *   2. Approve the $U token as the session's ERC-1271 signature checker —
 *      so the token can verify the smart-account signature when Binance's
 *      facilitator settles the EIP-3009 authorization.
 *   3. fetchWithX402 → HyreAgent's top-trader-wallets endpoint (0.08 $U).
 *
 * Run: bun run live-b402-buy.ts [url]
 */
import { formatUnits } from "viem";
import {
  createClient,
  signerFromPrivateKey,
  fetchWithX402,
  PERMIT2_ADDRESS,
  BNB,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";

const STATE_FILE = new URL("./.live-hire-state.json", import.meta.url).pathname;
const U = "0xcE24439F2D9C6a2289F741120FE202248B666666" as const;
const URL_TO_BUY = process.argv[2] ?? "https://mpp.hyreagent.fun/bsc/traders/top-wallets";

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const publicClient = buildPublicClient(BNB);

async function main() {
  const state = JSON.parse(await Bun.file(STATE_FILE).text());
  const client = createClient({ chains: [BNB] });
  const admin = signerFromPrivateKey(state.adminPrivateKey);
  const wallet = await client.createWallet({ signer: admin });

  const balBefore = await publicClient.readContract({ address: U, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address] });
  console.log(`[1] wallet ${wallet.address} — ${formatUnits(balBefore, 18)} $U`);

  // Reuse a previously-provisioned session if present; otherwise set one up.
  let session;
  if (state.b402SessionKey) {
    const sessionSigner = signerFromPrivateKey(state.b402SessionKey);
    const perms = state.b402SessionPermissions ?? {};
    if (perms.spend) perms.spend = perms.spend.map((s: any) => ({ ...s, limit: BigInt(s.limit) }));
    session = { walletAddress: wallet.address, signer: sessionSigner, publicKey: sessionSigner.publicKey, permissions: perms, expiry: state.b402SessionExpiry };
    console.log("[2] reusing provisioned session key");
  } else {
    console.log("[2] granting spend-limited session key via relay ...");
    session = await client.grantSession({
      wallet,
      signer: admin,
      chainId: 56,
      permissions: { spend: [{ limit: 500_000_000_000_000_000n, period: "day", token: U }] }, // ≤0.5 $U/day
      expiry: Math.floor(Date.now() / 1000) + 7 * 86400,
      register: false, // skip KeyStore listing (mainnet registration reverts); account-level authorization is what settlement checks
    });
    await new Promise((r) => setTimeout(r, 8000));
    console.log("    approving $U as the session's signature checker ...");
    await client.approveSignatureChecker({ wallet, signer: admin, session, checker: U, chainId: 56 });
    await new Promise((r) => setTimeout(r, 8000));
    state.b402SessionKey = (session.signer as unknown as { _privateKey: string })._privateKey;
    state.b402SessionPermissions = session.permissions;
    state.b402SessionExpiry = session.expiry;
    await Bun.write(STATE_FILE, JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log("    session persisted");
  }

  if (!state.permit2Ready) {
    console.log("[2b] approving $U to Permit2 + Permit2 as signature checker ...");
    await client.approveTokenForPermit2({ wallet, signer: admin, token: U, chainId: 56 });
    await new Promise((r) => setTimeout(r, 8000));
    await client.approveSignatureChecker({ wallet, signer: admin, session, checker: PERMIT2_ADDRESS, chainId: 56 });
    await new Promise((r) => setTimeout(r, 8000));
    state.permit2Ready = true;
    await Bun.write(STATE_FILE, JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  }

  console.log(`[3] paying ${URL_TO_BUY} ...`);
  const res = await fetchWithX402(session, URL_TO_BUY, undefined, { chainId: 56, preferRail: "permit2" });
  const body = await res.text();
  const balAfter = await publicClient.readContract({ address: U, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet.address] });

  console.log(`    HTTP ${res.status}`);
  console.log(`    paid: ${formatUnits(balBefore - balAfter, 18)} $U`);
  console.log(`    body: ${body.slice(0, 1200)}`);
}

main().catch((e) => {
  console.error("FAIL:", e?.shortMessage ?? e?.message ?? e);
  console.error("DETAILS:", e?.details ?? "");
  console.error("META:", (e?.metaMessages ?? []).join(" | ").slice(0, 400));
  process.exit(1);
});
