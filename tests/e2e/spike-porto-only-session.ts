/**
 * Isolated Porto session-key spike — does NOT touch Altana KeyStore.
 *
 * Goal: determine whether Porto's session-key execute path works on Sepolia
 * end-to-end. Our smoke-session.ts test passed grant + revoke + post-revoke
 * rejection, but the session-signed execute itself stalls at Porto status 300
 * forever — never lands on-chain. We need to know if that's:
 *   (a) Porto session-key bug on Sepolia (test will stall here too), or
 *   (b) interaction with our KeyStore initialRegisterKey prepend (test passes).
 *
 * Flow (pure Porto, no @altana calls beyond a public client and config):
 *   1. Generate admin EOA
 *   2. prepareUpgradeAccount + upgradeAccount → counterfactual smart account
 *   3. Fund EOA from deployer
 *   4. Admin execute (warm-up — proves Porto deploys + executes)
 *   5. grantSession via prepareCalls(authorizeKeys)
 *   6. Session execute via prepareCalls + session-key signing
 *   7. Report status 300 timing
 *
 * Recipient is a fresh EOA (not the deployer) and value is non-dust (1 gwei)
 * to rule out parameter-specific heuristics in Porto's bundler.
 *
 * Run: bun run packages/wallet/scripts/spike-porto-only-session.ts
 */

import {
  prepareUpgradeAccount,
  upgradeAccount,
  prepareCalls,
  signCalls,
  sendPreparedCalls,
  getCallsStatus,
} from "porto/viem/RelayActions";
import * as Key from "porto/viem/Key";
import {
  createWalletClient,
  http,
  parseEther,
  parseGwei,
  type Hex,
} from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";
import { sepolia } from "viem/chains";
import { SEPOLIA } from "@altananetwork/sdk";
import {
  buildPublicClient,
  buildRelayClient,
} from "../../packages/wallet/src/internal/relay.js";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY env var. Locally: .env. CI: GitHub Actions secret.",
  );
}

const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

function ms(start: number) {
  return `${((performance.now() - start) / 1000).toFixed(2)}s`;
}

async function pollStatus(
  relayClient: any,
  callsId: Hex,
  label: string,
  timeoutMs = 180_000,
): Promise<{ code: any; txHash?: Hex }> {
  const start = performance.now();
  const deadline = Date.now() + timeoutMs;
  let lastCode: any = null;
  while (Date.now() < deadline) {
    try {
      const s: any = await getCallsStatus(relayClient, { id: callsId });
      const code = s?.status;
      if (code !== lastCode) {
        console.log(`    [${label}] status=${code} t=${ms(start)}`);
        lastCode = code;
      }
      if (code === 200 || code === "CONFIRMED") {
        return { code, txHash: s?.receipts?.[0]?.transactionHash };
      }
      if (code === 500 || code === 400 || code === "FAILED") {
        return { code };
      }
    } catch (err) {
      console.log(`    [${label}] poll err: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { code: `TIMEOUT(last=${lastCode})` };
}

async function main() {
  console.log("Porto-only session spike — Sepolia");
  console.log("isolating Porto session-key path from Altana KeyStore");
  console.log("===================================================\n");

  const t0 = performance.now();
  const relayClient = buildRelayClient(SEPOLIA);
  const publicClient = buildPublicClient(SEPOLIA);

  const deployer = privateKeyToAccount(TEST_FUNDER_KEY);
  const deployerClient = createWalletClient({
    account: deployer,
    chain: sepolia,
    transport: http(SEPOLIA.publicRpcUrl),
  });

  // 1. Admin EOA
  console.log("[1] Generate admin EOA");
  const adminPk = generatePrivateKey();
  const admin = privateKeyToAccount(adminPk);
  const adminKey = Key.fromSecp256k1({ privateKey: adminPk, role: "admin" });
  console.log("    admin.address:", admin.address);

  // 2. Counterfactual upgrade to Porto smart account
  console.log("\n[2] prepareUpgradeAccount + upgradeAccount (counterfactual)");
  const prepared: any = await prepareUpgradeAccount(relayClient, {
    address: admin.address,
    authorizeKeys: [adminKey],
  });
  const signatures: Record<string, Hex> = {};
  for (const [name, digest] of Object.entries(prepared.digests ?? {})) {
    signatures[name] = await admin.sign({ hash: digest as Hex });
  }
  await upgradeAccount(relayClient as any, {
    context: prepared.context,
    signatures,
  } as any);
  console.log(`    upgraded [${ms(t0)}]`);

  // 3. Fund the EOA (so Porto has fee gas at execute time)
  console.log("\n[3] Fund admin EOA from deployer (0.003 ETH)");
  const fundTx = await deployerClient.sendTransaction({
    to: admin.address,
    value: parseEther("0.003"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log(`    funded [${ms(t0)}]`);

  // Fresh recipient — NOT the deployer (rules out address-specific heuristics)
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  console.log("    recipient:", recipient);

  // 4. Admin warm-up execute — pure Porto, no KeyStore prepend
  console.log("\n[4] Admin execute (warm-up, deploys setCode preCall)");
  const adminPrep: any = await prepareCalls(relayClient, {
    account: admin,
    calls: [
      { to: recipient, value: parseGwei("1"), data: "0x" as Hex },
    ],
    feeToken: NATIVE_TOKEN,
  });
  const adminSig = await signCalls(adminPrep, {
    address: admin.address,
    sign: async ({ hash }: any) => admin.sign({ hash }),
    key: adminKey,
  } as any);
  const adminSent: any = await sendPreparedCalls(relayClient as any, {
    context: adminPrep.context,
    capabilities: adminPrep.capabilities,
    signature: adminSig,
  } as any);
  const adminCallsId = (adminSent?.id ?? adminSent) as Hex;
  console.log("    callsId:", adminCallsId);
  const adminRes = await pollStatus(relayClient, adminCallsId, "admin", 180_000);
  console.log("    admin result:", adminRes.code, adminRes.txHash ?? "");
  if (adminRes.code !== 200 && adminRes.code !== "CONFIRMED") {
    console.log("    ❌ admin warm-up did not confirm — Porto baseline broken on this run");
    return;
  }

  // 5. Grant session key — pure prepareCalls with authorizeKeys, admin-signed
  console.log("\n[5] grantSession (1h, scoped to recipient, 1 ETH/day)");
  const sessionPk = generatePrivateKey();
  const sessionAcct = privateKeyToAccount(sessionPk);
  const sessionExpiry = Math.floor(Date.now() / 1000) + 3600;
  const sessionPermissions = {
    calls: [{ to: recipient }],
    spend: [{ limit: parseEther("1"), period: "day" as const }],
  };
  const sessionKey = Key.fromSecp256k1({
    privateKey: sessionPk,
    role: "session",
    expiry: sessionExpiry,
    permissions: sessionPermissions,
  } as any);

  const grantPrep: any = await prepareCalls(relayClient, {
    account: admin,
    calls: [],
    feeToken: NATIVE_TOKEN,
    authorizeKeys: [sessionKey],
  } as any);
  const grantSig = await signCalls(grantPrep, {
    address: admin.address,
    sign: async ({ hash }: any) => admin.sign({ hash }),
    key: adminKey,
  } as any);
  const grantSent: any = await sendPreparedCalls(relayClient as any, {
    context: grantPrep.context,
    capabilities: grantPrep.capabilities,
    signature: grantSig,
  } as any);
  const grantCallsId = (grantSent?.id ?? grantSent) as Hex;
  console.log("    callsId:", grantCallsId);
  const grantRes = await pollStatus(relayClient, grantCallsId, "grant", 180_000);
  console.log("    grant result:", grantRes.code, grantRes.txHash ?? "");
  if (grantRes.code !== 200 && grantRes.code !== "CONFIRMED") {
    console.log("    ❌ grant did not confirm — abort");
    return;
  }

  // 6. THE TEST: session-signed execute, pure Porto, no KeyStore prepend
  console.log("\n[6] SESSION execute — the actual test");
  console.log("    signer = session key (different from admin)");
  console.log("    wallet = admin.address (the upgraded EOA)");
  const sessionPrep: any = await prepareCalls(relayClient, {
    account: admin.address, // wallet address, not the admin account object
    calls: [
      { to: recipient, value: parseGwei("1"), data: "0x" as Hex },
    ],
    feeToken: NATIVE_TOKEN,
    key: sessionKey, // tells Porto which key will sign
  } as any);
  const sessionSig = await signCalls(sessionPrep, {
    address: sessionAcct.address,
    sign: async ({ hash }: any) => sessionAcct.sign({ hash }),
    key: sessionKey,
  } as any);
  const sessionSent: any = await sendPreparedCalls(relayClient as any, {
    context: sessionPrep.context,
    capabilities: sessionPrep.capabilities,
    signature: sessionSig,
  } as any);
  const sessionCallsId = (sessionSent?.id ?? sessionSent) as Hex;
  console.log("    callsId:", sessionCallsId);
  console.log("    polling up to 180s for status transition...");
  const sessionRes = await pollStatus(relayClient, sessionCallsId, "session", 180_000);
  console.log("\n    session result:", sessionRes.code, sessionRes.txHash ?? "");

  console.log("\n===================================================");
  console.log(`Total: ${ms(t0)}`);
  if (sessionRes.code === 200 || sessionRes.code === "CONFIRMED") {
    console.log("✅ VERDICT: Porto session-key execute WORKS on Sepolia");
    console.log("    Issue must be in our execute() integration with KeyStore");
  } else {
    console.log("❌ VERDICT: Porto session-key execute does NOT confirm");
    console.log(`    Final status: ${sessionRes.code}`);
    console.log("    This is a Porto-level issue, not a Altana integration bug");
  }
}

main().catch((err) => {
  console.error("\nSpike crashed:", err);
  process.exit(1);
});
