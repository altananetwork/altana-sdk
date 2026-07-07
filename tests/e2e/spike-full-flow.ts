/**
 * Spike #2b — Full Porto upgrade flow with requiredFunds
 *
 * What was wrong with spike #2a:
 *   I called prepareCalls directly on a fresh EOA. Porto's relayer needs the
 *   account to be REGISTERED (counterfactually upgraded) via upgradeAccount
 *   before prepareCalls will work. That's why we got bare `0x` rejections.
 *
 * The real flow:
 *   1. prepareUpgradeAccount(client, { address, authorizeKeys }) → returns
 *      a context + digests-to-sign
 *   2. Sign the digests with the EOA's private key
 *   3. upgradeAccount(client, { context, signatures }) → relayer stores the
 *      counterfactual upgrade. NOT submitted on-chain.
 *   4. prepareCalls(client, { account, calls, requiredFunds, feeToken }) →
 *      relayer returns a signed quote for the user's first intent
 *   5. signCalls(prepared, { ... }) → user signs the call digest
 *   6. sendPreparedCalls(client, { ... }) → relayer bundles setCode + calls
 *      into a single tx via the Altana account orchestrator
 *
 * This spike runs steps 1-4 against Sepolia and reports whether requiredFunds
 * is accepted. We stop short of submission (step 6) to avoid using gas.
 *
 * Run: bun run packages/wallet/scripts/spike-full-flow.ts
 */

import {
  prepareUpgradeAccount,
  upgradeAccount,
  prepareCalls,
  health,
} from "porto/viem/RelayActions";
import * as Key from "porto/viem/Key";
import { sepolia } from "viem/chains";
import { createClient, http, parseEther, encodeFunctionData, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const RELAY_URL = "https://relay.altana.network";
const SEPOLIA_WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const WETH_DEPOSIT_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
] as const;
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";
const SEPOLIA_EXP: Address = "0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e";

async function main() {
  console.log("Spike #2b — Full Porto upgrade flow + requiredFunds");
  console.log("====================================================\n");

  const client = createClient({
    chain: sepolia,
    transport: http(RELAY_URL),
  });

  // Health check.
  await health(client as any);

  // Step 1: Fresh EOA.
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log("Fresh EOA:", account.address);

  // The admin key — what gets registered on the account during upgrade.
  const adminKey = Key.createSecp256k1({ privateKey, role: "admin" });

  // Step 2: prepareUpgradeAccount — gets counterfactual upgrade payload.
  console.log("\nStep 2: prepareUpgradeAccount");
  let upgradeContext;
  try {
    const result = await prepareUpgradeAccount(client as any, {
      address: account.address,
      authorizeKeys: [adminKey],
    });
    upgradeContext = result;
    console.log("  Got upgrade context. Digests to sign:", Object.keys((result as any).digests ?? {}));
  } catch (err) {
    console.log("  FAIL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Step 3: Sign the digests with the EOA.
  console.log("\nStep 3: Sign digests with EOA");
  const digests = (upgradeContext as any).digests;
  const signatures: any = {};
  for (const [name, digest] of Object.entries(digests ?? {})) {
    const sig = await account.sign({ hash: digest as `0x${string}` });
    signatures[name] = sig;
    console.log(`  Signed ${name}: ${sig.slice(0, 20)}...`);
  }

  // Step 4: upgradeAccount — registers the upgrade with the relayer.
  console.log("\nStep 4: upgradeAccount (register counterfactual upgrade)");
  try {
    const upgraded = await upgradeAccount(client as any, {
      context: (upgradeContext as any).context,
      signatures,
    });
    console.log("  Account registered. Keys count:", (upgraded as any).keys?.length);
  } catch (err) {
    console.log("  FAIL:", err instanceof Error ? err.message : String(err));
    console.log("  Full error:", err);
    process.exit(1);
  }

  // Step 5: prepareCalls with a payable call AND requiredFunds.
  console.log("\nStep 5: prepareCalls with requiredFunds (ETH path)");
  const payableCall = {
    to: SEPOLIA_WETH,
    value: parseEther("0.0001"),
    data: encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit", args: [] }),
  };

  try {
    const prepared = await prepareCalls(client as any, {
      account,
      calls: [payableCall],
      feeToken: NATIVE_ETH,
      requiredFunds: [{ address: NATIVE_ETH, value: parseEther("0.0001") }],
    } as any);
    console.log("  ✓ ACCEPTED. Quote:");
    console.log("    fee token:", (prepared as any)?.capabilities?.quote?.intent?.paymentToken);
    console.log("    max payment:", (prepared as any)?.capabilities?.quote?.intent?.totalPaymentMaxAmount?.toString());
    console.log("\n  → Porto's Sepolia relayer ACCEPTS requiredFunds.");
    console.log("  → Architecture validated: msg.value flows via Porto's funder.");
    console.log("\n  Stopping before signCalls + sendPreparedCalls (no submission).");
    return;
  } catch (err) {
    console.log("  ✗ REJECTED:", err instanceof Error ? err.message : String(err));
    console.log("\n  Trying alternative: feeToken=EXP, requiredFunds=ETH");
  }

  // Fallback: EXP fee token.
  try {
    const prepared = await prepareCalls(client as any, {
      account,
      calls: [payableCall],
      feeToken: SEPOLIA_EXP,
      requiredFunds: [{ address: NATIVE_ETH, value: parseEther("0.0001") }],
    } as any);
    console.log("  ✓ ACCEPTED with EXP feeToken.");
    console.log("  → ETH-as-requiredFunds works when feeToken is EXP.");
  } catch (err) {
    console.log("  ✗ REJECTED:", err instanceof Error ? err.message : String(err));
    console.log("\nSPIKE #2b CONCLUSION: Porto's Sepolia relayer rejects our requiredFunds");
    console.log("requests. Likely: no funder configured for Sepolia, or our request");
    console.log("shape is wrong. Next step: try with EXP-only (no native ETH), or");
    console.log("contact Porto / read Orchestrator source for the actual flow.");
  }
}

main().catch((err) => {
  console.error("\nCrashed:", err);
  process.exit(1);
});
