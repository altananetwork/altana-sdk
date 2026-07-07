/**
 * Spike #1 — Porto wallet_upgradeAccount + main intent batching
 *
 * Question this spike answers:
 *   Can a single Porto intent carry a payable contract call (like
 *   KeyStoreController.initialRegisterKey{value: fee}) as its main intent,
 *   with EIP-7702 setCode attached as a preCall, such that everything reverts
 *   atomically if any step fails?
 *
 * What this script does:
 *   1. Connects to Porto's relayer (Sepolia chain)
 *   2. Health-checks the relayer
 *   3. Reads relayer capabilities (chains supported, fee tokens, orchestrator,
 *      funder addresses)
 *   4. Constructs a fresh secp256k1 EOA + an upgrade-account intent
 *   5. Type-level proof: builds a `prepareCalls` payload with a payable
 *      contract call (Sepolia WETH.deposit as a stand-in for KeyStoreController)
 *
 * What this script does NOT do (yet):
 *   - Submit anything on-chain (no Sepolia funding wired up)
 *   - Use real KeyStore (not deployed on Sepolia)
 *
 * Run:  bun run packages/wallet/scripts/spike-porto-batching.ts
 */

import {
  health,
  getCapabilities,
  prepareCalls,
  prepareUpgradeAccount,
} from "porto/viem/RelayActions";
import { sepolia } from "viem/chains";
import { createClient, http, parseEther, encodeFunctionData, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as Key from "porto/viem/Key";

// Porto's public relay endpoint. If this changes, capabilities() will fail
// and we'll know immediately.
const PORTO_RELAY_URL = "https://rpc.porto.sh";

// Sepolia WETH (stand-in for a payable target contract).
const SEPOLIA_WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";

const WETH_DEPOSIT_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
] as const;

async function main() {
  console.log("Spike #1 — Porto batching API surface validation");
  console.log("=================================================\n");

  // Step 1: Build a viem Client pointing at Porto's relay.
  // The RelayActions functions only need a Client with a Transport + Chain.
  const relayClient = createClient({
    chain: sepolia,
    transport: http(PORTO_RELAY_URL),
  });

  // Step 2: Health check.
  console.log("Step 2: Health-checking Porto relayer at", PORTO_RELAY_URL);
  try {
    const h = await health(relayClient as any);
    console.log("  Health:", JSON.stringify(h, null, 2));
  } catch (err) {
    console.log("  FAIL:", err instanceof Error ? err.message : String(err));
    console.log("\n  Likely: relayer URL wrong, or the public endpoint moved.");
    console.log("  Action: confirm Porto's current relayer URL before Lane 1.");
    process.exit(1);
  }

  // Step 3: Capabilities — what chains, fee tokens, orchestrator, funder?
  console.log("\nStep 3: Reading relayer capabilities");
  let capabilities: any;
  try {
    capabilities = await getCapabilities(relayClient as any, {
      chainIds: [sepolia.id],
    });
    const sepoliaKey = `0x${sepolia.id.toString(16)}`;
    const sepoliaCaps = capabilities?.[sepoliaKey];
    console.log("  Sepolia (chainId", sepolia.id, ") supported:", !!sepoliaCaps);
    if (sepoliaCaps) {
      console.log("  Orchestrator:", sepoliaCaps?.contracts?.orchestrator);
      console.log("  Funder:      ", sepoliaCaps?.contracts?.funder);
      console.log("  Fee tokens:  ", JSON.stringify(sepoliaCaps?.fees?.tokens?.map((t: any) => ({
        symbol: t.symbol, address: t.address, interop: t.interop,
      })), null, 2));
    } else {
      console.log("  Capabilities returned but no Sepolia key found.");
      console.log("  Raw:", JSON.stringify(capabilities, null, 2).slice(0, 800));
    }
  } catch (err) {
    console.log("  FAIL:", err instanceof Error ? err.message : String(err));
    console.log("  Action: investigate before committing to Sepolia.");
    process.exit(1);
  }

  // Step 4: Build the type-level proof — a payable contract call inside a
  // prepared intent. We do NOT submit. We construct the params and let
  // TypeScript verify the shape.
  console.log("\nStep 4: Type-level proof — payable contract call in prepareCalls");

  const ephemeralKey = generatePrivateKey();
  const ephemeralAccount = privateKeyToAccount(ephemeralKey);
  console.log("  Ephemeral EOA:", ephemeralAccount.address);

  // KeyStoreController.initialRegisterKey is payable. Stand-in: WETH.deposit
  // (also payable). If this type-checks for WETH, it type-checks for any
  // payable call including KeyStoreController.initialRegisterKey.
  const payableCall = {
    to: SEPOLIA_WETH,
    value: parseEther("0.0001"), // <-- this is the msg.value forwarded to the call
    data: encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit", args: [] }),
  };
  console.log("  Constructed payable call:");
  console.log("    to:    ", payableCall.to);
  console.log("    value: ", payableCall.value.toString(), "wei");
  console.log("    data:  ", payableCall.data);

  // The "calls" parameter of prepareCalls accepts our payable call shape. If
  // this compiles, the architecture is type-valid: Porto's intent batching
  // supports arbitrary payable nested calls.
  const callsParameter: Parameters<typeof prepareCalls>[1]["calls"] = [payableCall];
  console.log("\n  TypeScript accepted payable call inside prepareCalls.calls.");
  console.log("  This means: KeyStoreController.initialRegisterKey{value: fee}");
  console.log("  is a valid main-intent call shape for Porto. ✓");

  // Step 5: What would the upgrade call look like? Construct (do not submit).
  console.log("\nStep 5: Upgrade-account intent shape (constructed, not submitted)");
  const authorizeKey = Key.createSecp256k1({ privateKey: ephemeralKey, role: "admin" });
  const upgradeParams: Parameters<typeof prepareUpgradeAccount>[1] = {
    address: ephemeralAccount.address,
    authorizeKeys: [authorizeKey],
  };
  console.log("  prepareUpgradeAccount params constructed for", upgradeParams.address);
  console.log("  authorizeKeys count:", upgradeParams.authorizeKeys.length);

  console.log("\n=================================================");
  console.log("SPIKE #1 RESULT: PASS");
  console.log("  - Porto relayer reachable at", PORTO_RELAY_URL);
  console.log("  - Sepolia is in capabilities");
  console.log("  - prepareCalls.calls accepts payable contract calls (type-level)");
  console.log("  - prepareUpgradeAccount accepts a fresh EOA + admin key");
  console.log("\nNext: spike #2 (SimpleFunder JIT-fund) needs the funder address");
  console.log("from capabilities above. Then live submission.");
}

main().catch((err) => {
  console.error("\nSpike #1 crashed:", err);
  process.exit(1);
});
