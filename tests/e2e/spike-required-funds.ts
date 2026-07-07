/**
 * Spike #2 — Porto requiredFunds / msg.value JIT-funding on Sepolia
 *
 * Question this spike answers:
 *   How does an EIP-7702 Porto account, freshly upgraded from a zero-balance
 *   EOA on Sepolia, source msg.value for a nested payable call (like
 *   KeyStoreController.initialRegisterKey{value: 0.5_USD}(...))?
 *
 * Hypothesis (from reading Porto source):
 *   `prepareCalls` accepts a `requiredFunds` capability. The relayer reads
 *   this, computes a digest, calls SimpleFunder.fund(digest, transfers, sig)
 *   to pull ETH from a pre-funded SimpleFunder contract, then forwards the
 *   ETH through the Orchestrator into the user's intent (including any
 *   nested `value:` field).
 *
 * What this script does:
 *   1. Dumps the full Sepolia capabilities response (look for funder)
 *   2. Calls prepareCalls() WITH requiredFunds on a fresh EOA
 *   3. Reports whether Porto's relayer accepts or rejects the intent
 *
 * Possible outcomes:
 *   - ACCEPTED → Porto has a funder configured for Sepolia (even though
 *     capabilities.contracts.funder is undefined). We can rely on Porto's
 *     hosted funding mechanism. Altana needs to do nothing extra.
 *   - REJECTED (no funder) → Altana must deploy its own SimpleFunder on
 *     Sepolia, register it with Porto (out-of-band), and possibly run a
 *     merchant RPC endpoint to sign funder digests.
 *   - REJECTED (other reason) → diagnostic information for next step.
 *
 * Run:  bun run packages/wallet/scripts/spike-required-funds.ts
 */

import {
  getCapabilities,
  prepareCalls,
} from "porto/viem/RelayActions";
import * as Key from "porto/viem/Key";
import { sepolia } from "viem/chains";
import { createClient, http, parseEther, encodeFunctionData, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const RELAY_URL = "https://relay.altana.network";

// Sepolia WETH — payable target. WETH.deposit{value: x}() forwards msg.value
// to mint WETH. Stands in for KeyStoreController.initialRegisterKey{value: fee}.
const SEPOLIA_WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const WETH_DEPOSIT_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

// Sepolia native ETH (per capabilities). Used as both fee token and required funds.
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";

// EXP token on Sepolia (alternative fee token). Sometimes Porto's flow requires
// using a non-native fee token for the requiredFunds path because the relayer
// needs to denominate value in a token it can pull through the funder.
const SEPOLIA_EXP: Address = "0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e";

async function main() {
  console.log("Spike #2 — Porto requiredFunds + msg.value JIT-funding");
  console.log("======================================================\n");

  const relayClient = createClient({
    chain: sepolia,
    transport: http(RELAY_URL),
  });

  // Step 1: Full capabilities dump — look for any funder reference.
  console.log("Step 1: Full Sepolia capabilities dump");
  const caps = await getCapabilities(relayClient as any, { chainIds: [sepolia.id] });
  const sepoliaKey = `0x${sepolia.id.toString(16)}`;
  const sepoliaCaps = (caps as any)?.[sepoliaKey];
  console.log(JSON.stringify(sepoliaCaps, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2));
  console.log();

  // Step 2: Construct an intent with requiredFunds on a fresh EOA.
  // The EOA has zero ETH. If Porto's relayer can fund the intent via
  // requiredFunds, the architecture works.
  console.log("Step 2: prepareCalls with requiredFunds (ETH path)");
  const ephemeralKey = generatePrivateKey();
  const ephemeralAccount = privateKeyToAccount(ephemeralKey);
  console.log("  Fresh EOA:", ephemeralAccount.address, "(zero balance)");

  const adminKey = Key.createSecp256k1({ privateKey: ephemeralKey, role: "admin" });

  const payableCall = {
    to: SEPOLIA_WETH,
    value: parseEther("0.0001"),
    data: encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit", args: [] }),
  };

  // ATTEMPT A: native ETH as both feeToken and requiredFunds.
  console.log("\n  Attempt A: feeToken=ETH, requiredFunds=ETH");
  try {
    const prepared = await prepareCalls(relayClient as any, {
      account: ephemeralAccount,
      authorizeKeys: [adminKey],
      calls: [payableCall],
      feeToken: NATIVE_ETH,
      requiredFunds: [{ address: NATIVE_ETH, value: parseEther("0.0001") }],
    } as any);
    console.log("  ACCEPTED. Quote returned.");
    console.log("  Quote fee total:", (prepared as any)?.capabilities?.quote?.intent?.totalPaymentMaxAmount);
    console.log("  → Porto's Sepolia relayer has a funder. Architecture validated.");
    return;
  } catch (err) {
    console.log("  REJECTED:", err instanceof Error ? err.message : String(err));
  }

  // ATTEMPT B: EXP as feeToken, native ETH as requiredFunds.
  console.log("\n  Attempt B: feeToken=EXP, requiredFunds=ETH");
  try {
    const prepared = await prepareCalls(relayClient as any, {
      account: ephemeralAccount,
      authorizeKeys: [adminKey],
      calls: [payableCall],
      feeToken: SEPOLIA_EXP,
      requiredFunds: [{ address: NATIVE_ETH, value: parseEther("0.0001") }],
    } as any);
    console.log("  ACCEPTED. Quote returned.");
    console.log("  → Porto accepts ETH-as-requiredFunds when feeToken differs.");
    return;
  } catch (err) {
    console.log("  REJECTED:", err instanceof Error ? err.message : String(err));
  }

  // ATTEMPT C: No requiredFunds, just the call. See if the relayer errors
  // out cleanly about value-without-funding (diagnostic).
  console.log("\n  Attempt C: no requiredFunds (diagnostic — expect failure)");
  try {
    const prepared = await prepareCalls(relayClient as any, {
      account: ephemeralAccount,
      authorizeKeys: [adminKey],
      calls: [payableCall],
      feeToken: NATIVE_ETH,
    } as any);
    console.log("  ACCEPTED (surprising). Porto somehow funded the call.");
  } catch (err) {
    console.log("  REJECTED:", err instanceof Error ? err.message : String(err));
  }

  console.log("\n======================================================");
  console.log("SPIKE #2 SUMMARY:");
  console.log("  If all attempts rejected with 'funder not configured' or similar:");
  console.log("    → Altana must deploy SimpleFunder on Sepolia + register with Porto");
  console.log("  If any attempt accepted:");
  console.log("    → Porto's Sepolia relayer has a funder. Use that path.");
}

main().catch((err) => {
  console.error("\nSpike #2 crashed:", err);
  process.exit(1);
});
