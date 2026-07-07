/**
 * Spike #2c — End-to-end: upgrade + faucet + prepareCalls on Sepolia
 *
 * What we learned from #2b:
 *   prepareCalls without requiredFunds rejects with bare 0x. Likely because
 *   the EOA has no balance to pay fees. requiredFunds also rejects — Porto's
 *   Sepolia relayer doesn't have a funder configured for that path.
 *
 *   BUT Porto exposes wallet_addFaucetFunds — a testnet faucet RPC method.
 *   This is the actual funding mechanism for Sepolia.
 *
 * The real v0 flow:
 *   1. prepareUpgradeAccount + sign + upgradeAccount (register)
 *   2. addFaucetFunds (testnet ETH/EXP to the EOA)
 *   3. prepareCalls with payable call (no requiredFunds needed — EOA has ETH)
 *   4. signCalls + sendPreparedCalls (one tx: setCode + main call)
 *
 * This spike times the full path so we know if v0's 60-second claim survives.
 *
 * Run: bun run packages/wallet/scripts/spike-e2e-faucet.ts
 */

import {
  prepareUpgradeAccount,
  upgradeAccount,
  addFaucetFunds,
  prepareCalls,
  signCalls,
  sendPreparedCalls,
  getCallsStatus,
} from "porto/viem/RelayActions";
import * as Key from "porto/viem/Key";
import { sepolia } from "viem/chains";
import { createClient, createPublicClient, http, parseEther, encodeFunctionData, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const SEPOLIA_PUBLIC_RPC = "https://ethereum-sepolia-rpc.publicnode.com";

const PORTO_RELAY_URL = "https://rpc.porto.sh";
const SEPOLIA_WETH: Address = "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14";
const WETH_DEPOSIT_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
] as const;
const NATIVE_ETH: Address = "0x0000000000000000000000000000000000000000";
const SEPOLIA_EXP: Address = "0xfca413a634c4df6b98ebb970a44d9a32f8f5c64e";

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}

async function main() {
  console.log("Spike #2c — Full e2e: upgrade + faucet + execute");
  console.log("=================================================\n");

  const t0 = performance.now();

  const client = createClient({
    chain: sepolia,
    transport: http(PORTO_RELAY_URL, { timeout: 60_000 }),
  });

  // Step 1: Fresh EOA.
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log("EOA:", account.address, `[${ms(t0)}]`);

  const adminKey = Key.createSecp256k1({ privateKey, role: "admin" });

  // Step 2: prepareUpgradeAccount + sign + upgradeAccount.
  console.log("\n[2] prepareUpgradeAccount");
  const upgradeResult: any = await prepareUpgradeAccount(client as any, {
    address: account.address,
    authorizeKeys: [adminKey],
  });
  console.log(`    done [${ms(t0)}]`);

  const signatures: any = {};
  for (const [name, digest] of Object.entries(upgradeResult.digests ?? {})) {
    signatures[name] = await account.sign({ hash: digest as `0x${string}` });
  }
  console.log(`    signed digests [${ms(t0)}]`);

  await upgradeAccount(client as any, {
    context: upgradeResult.context,
    signatures,
  });
  console.log(`    upgradeAccount registered [${ms(t0)}]`);

  // Step 3: Faucet some ETH to the EOA. Need enough to cover:
  //   - msg.value for the WETH.deposit call (0.0001 ETH)
  //   - Porto's fee (variable, paid in fee token)
  // Try faucet ETH first, fall back to EXP if needed.
  console.log("\n[3] addFaucetFunds");
  let faucetWorked = false;
  try {
    const fauceted = await addFaucetFunds(client as any, {
      address: account.address,
      tokenAddress: NATIVE_ETH,
      value: parseEther("0.01"),
    });
    console.log(`    faucet ETH tx: ${fauceted.transactionHash} [${ms(t0)}]`);
    faucetWorked = true;
  } catch (err) {
    console.log(`    faucet ETH FAILED: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);

    // Try EXP.
    try {
      const fauceted = await addFaucetFunds(client as any, {
        address: account.address,
        tokenAddress: SEPOLIA_EXP,
        value: parseEther("100"),
      });
      console.log(`    faucet EXP tx: ${fauceted.transactionHash} [${ms(t0)}]`);
      faucetWorked = true;
    } catch (err2) {
      console.log(`    faucet EXP FAILED: ${err2 instanceof Error ? err2.message.slice(0, 200) : String(err2)}`);
    }
  }

  if (!faucetWorked) {
    console.log("\n  Faucet unreachable. Cannot proceed with prepareCalls.");
    console.log("  Conclusion: need an alternative funding path on Sepolia.");
    return;
  }

  // Step 3.5: Wait for faucet to be visible on-chain. Otherwise prepareCalls
  // simulates against zero-balance EOA and rejects with bare 0x.
  console.log("\n[3.5] Wait for faucet tx to land on-chain");
  const publicClient = createPublicClient({
    chain: sepolia,
    transport: http(SEPOLIA_PUBLIC_RPC),
  });
  let balance = 0n;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    balance = await publicClient.getBalance({ address: account.address });
    console.log(`    poll ${i + 1}: balance = ${balance.toString()} wei [${ms(t0)}]`);
    if (balance > 0n) break;
  }
  if (balance === 0n) {
    console.log("    faucet tx didn't land within 40s. Aborting.");
    return;
  }

  // Step 4: prepareCalls with payable call.
  console.log("\n[4] prepareCalls");
  const payableCall = {
    to: SEPOLIA_WETH,
    value: parseEther("0.0001"),
    data: encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit", args: [] }),
  };

  let prepared: any;
  try {
    prepared = await prepareCalls(client as any, {
      account,
      calls: [payableCall],
      feeToken: SEPOLIA_EXP,  // pay fees in EXP
    } as any);
    console.log(`    quote received [${ms(t0)}]`);
    const intent = prepared?.capabilities?.quote?.intent;
    if (intent) {
      console.log(`    payment token: ${intent.paymentToken}`);
      console.log(`    max payment:   ${intent.totalPaymentMaxAmount?.toString()}`);
    }
  } catch (err) {
    console.log(`    REJECTED: ${err instanceof Error ? err.message : String(err)}`);
    console.log("\n  Trying with feeToken=ETH instead");
    try {
      prepared = await prepareCalls(client as any, {
        account,
        calls: [payableCall],
        feeToken: NATIVE_ETH,
      } as any);
      console.log(`    quote received with ETH feeToken [${ms(t0)}]`);
    } catch (err2) {
      console.log(`    REJECTED again: ${err2 instanceof Error ? err2.message : String(err2)}`);
      console.log("\nCannot prepare calls even with faucet funding. Stopping.");
      return;
    }
  }

  // Step 5: signCalls.
  console.log("\n[5] signCalls");
  const callsSignature = await signCalls(prepared, {
    address: account.address,
    sign: async ({ hash }: any) => account.sign({ hash }),
    key: adminKey,
  } as any);
  console.log(`    signed [${ms(t0)}]`);

  // Step 6: sendPreparedCalls.
  console.log("\n[6] sendPreparedCalls");
  const sent: any = await sendPreparedCalls(client as any, {
    context: prepared.context,
    capabilities: prepared.capabilities,
    signature: callsSignature,
  } as any);
  const callsId = sent?.id ?? sent;
  console.log(`    submitted, id: ${callsId} [${ms(t0)}]`);

  // Step 7: Poll for confirmation.
  console.log("\n[7] Wait for confirmation");
  let status: any;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      status = await getCallsStatus(client as any, { id: callsId });
      console.log(`    poll ${i + 1}: ${status?.status ?? "unknown"} [${ms(t0)}]`);
      if (status?.status === "CONFIRMED" || status?.status === 200) break;
      if (status?.status === "FAILED" || status?.status === 500) break;
    } catch (err) {
      console.log(`    poll ${i + 1} error: ${err instanceof Error ? err.message.slice(0, 100) : err}`);
    }
  }

  console.log("\n=================================================");
  console.log(`TOTAL WALL-CLOCK: ${ms(t0)}`);
  console.log("Final status:", status?.status);
  if (status?.receipts?.length) {
    console.log("Tx hash:", status.receipts[0]?.transactionHash);
  }
}

main().catch((err) => {
  console.error("\nCrashed:", err);
  process.exit(1);
});
