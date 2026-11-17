// E2E against the HOSTED (Railway) relay on BNB testnet, with the prod fee
// recipient. Same lifecycle as bnb-testnet.ts but relayUrl is overridden
// to the deployed relay so we exercise the production path end-to-end.

import {
  createClient,
  BNB_TESTNET,
  signerFromPrivateKey,
  createPrivateKeySigner,
} from "@altananetwork/sdk";
import {
  createClient as createRpcClient,
  createPublicClient,
  createWalletClient,
  http,
  numberToHex,
  parseEther,
  formatEther,
  type Address,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const log = (label: string, value?: unknown) => {
  console.log(`\n=== ${label} ===`);
  if (value !== undefined) console.log(value);
};

const RELAY_URL =
  process.env.RELAY_URL ?? "https://testnet-relay.altana.network";
/**
 * Where the relay collects its fees, read from the relay rather than
 * remembered.
 *
 * This was a hardcoded `0x20E8551E…`, which has not been the relay's recipient
 * for some time: the delta printed below came out 0 BNB on every run while the
 * relay was collecting normally, so the one assertion about fees in this script
 * was dead and read as a failed fee check (qa, 2026-11-09, section 6b). The
 * relay publishes the address in `wallet_getCapabilities` as `fees.recipient`,
 * per chain, so that is what is used; the constant below is only a fallback for
 * a relay that will not answer, and is the current configured recipient.
 */
const FALLBACK_FEE_RECIPIENT = "0xb248602EAadd9c3e2Db4575C4e4d58003b7a2740" as const;

const DEPLOYER_PK = process.env.DEPLOYER_KEY as `0x${string}`;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_KEY env var not set");

// BNB testnet config, but pointed at the hosted relay.
const BNB = { ...BNB_TESTNET, relayUrl: RELAY_URL };
const client = createClient({ chains: [BNB] });

const publicClient = createPublicClient({
  chain: bscTestnet,
  transport: http(BNB.publicRpcUrl),
});

type WireCapabilities = Record<string, { fees?: { recipient?: unknown } }>;

async function feeRecipient(): Promise<{ address: Address; from: string }> {
  const relay = createRpcClient({ transport: http(RELAY_URL) });
  try {
    const caps = (await relay.request({
      method: "wallet_getCapabilities" as never,
      params: [[numberToHex(BNB.chainId)]] as never,
    })) as WireCapabilities | null;
    for (const [key, value] of Object.entries(caps ?? {})) {
      const id = key.startsWith("0x") ? parseInt(key, 16) : Number(key);
      const recipient = value?.fees?.recipient;
      if (id === BNB.chainId && typeof recipient === "string" && recipient.startsWith("0x")) {
        return { address: recipient as Address, from: "wallet_getCapabilities" };
      }
    }
  } catch (err) {
    log("Could not read the relay's fee recipient", err instanceof Error ? err.message : err);
  }
  return { address: FALLBACK_FEE_RECIPIENT, from: "fallback constant" };
}

/**
 * Returns what is left of the admin EOA's funding to whoever paid it in.
 *
 * The admin key is made in this process and never leaves it, so anything left
 * behind is stranded for good: 0.0074 tBNB per run was accumulating at a
 * different dead address every time (qa, 2026-11-09, section 6b). One plain
 * transfer is reserved for the sweep's own gas, with a margin for the price
 * moving between the estimate and the send.
 */
export async function sweepBack(adminPk: `0x${string}`, to: Address): Promise<void> {
  const account = privateKeyToAccount(adminPk);
  const balance = await publicClient.getBalance({ address: account.address });
  const gasPrice = await publicClient.getGasPrice();
  const reserve = ((gasPrice * 21_000n) * 12n) / 10n;
  if (balance <= reserve) {
    log("Nothing to sweep", `${formatEther(balance)} BNB left at ${account.address}, less than its own gas`);
    return;
  }
  const value = balance - reserve;
  const adminWallet = createWalletClient({ account, chain: bscTestnet, transport: http(BNB.publicRpcUrl) });
  const hash = await adminWallet.sendTransaction({ to, value, gas: 21_000n, gasPrice });
  await publicClient.waitForTransactionReceipt({ hash });
  const dust = await publicClient.getBalance({ address: account.address });
  log("Swept back to the funder", {
    value: `${formatEther(value)} BNB`,
    to,
    hash,
    leftBehind: `${formatEther(dust)} BNB`,
  });
}

async function main() {
  log("Hosted relay", RELAY_URL);
  const fees = await feeRecipient();
  log("Fee recipient", `${fees.address} (from ${fees.from})`);
  const feeBefore = await publicClient.getBalance({ address: fees.address });
  log("Fee recipient balance BEFORE", `${formatEther(feeBefore)} BNB`);

  // 1. Fund a fresh admin EOA from the deployer.
  const adminPk = generatePrivateKey();
  const adminAccount = privateKeyToAccount(adminPk);
  log("Fresh admin EOA", adminAccount.address);

  const funder = privateKeyToAccount(DEPLOYER_PK);
  const deployerWallet = createWalletClient({
    account: funder,
    chain: bscTestnet,
    transport: http(BNB.publicRpcUrl),
  });
  const fundTx = await deployerWallet.sendTransaction({
    to: adminAccount.address,
    value: parseEther("0.01"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  log("Funded admin 0.01 BNB", fundTx);

  // Everything after the funding returns the remainder, including a run that
  // throws: a stranded admin key cannot be recovered afterwards.
  try {
    await lifecycle(adminPk, fees.address, feeBefore);
  } finally {
    await sweepBack(adminPk, funder.address).catch((err) => log("Sweep FAILED", err));
  }
}

async function lifecycle(adminPk: `0x${string}`, recipientOfFees: Address, feeBefore: bigint) {
  // 2. createWallet (counterfactual).
  const adminSigner = signerFromPrivateKey(adminPk);
  const wallet = await client.createWallet({ signer: adminSigner });
  log("Wallet", { address: wallet.address, chainId: BNB.chainId });

  // 3. grantSession — first on-chain action, SPONSORED BY THE HOSTED RELAY.
  const recipient = "0x000000000000000000000000000000000000dEaD" as const;
  const session = await client.grantSession({
    wallet,
    signer: adminSigner,
    sessionSigner: createPrivateKeySigner(),
    permissions: {
      calls: [{ to: recipient }],
      spend: [{ limit: parseEther("0.001"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  if (session.status !== "granted") {
    throw new Error(`grantSession failed: ${JSON.stringify(session.legs, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  }
  log("Session granted via hosted relay", { sessionPubKey: session.signer.publicKey });

  const code = await publicClient.getCode({ address: wallet.address });
  log("Wallet has 7702 delegation code?", code && code !== "0x" ? "YES" : "NO");

  // 4. execute as session.
  const exec = await client.execute({
    session,
    calls: { to: recipient, value: 1n, data: "0x" },
  });
  log("Execute result", { status: exec.status, txHash: exec.transactionHash });

  // 5. revoke.
  const revoke = await client.revokeSession({ wallet, signer: adminSigner, session });
  log("Revoke result", {
    status: revoke.status,
    legs: revoke.legs.map((l) => `${l.chainId} ${l.kind} ${l.status} ${l.transactionHash ?? l.reason ?? ""}`),
  });

  // 6. Fee recipient delta — proves the relay collected fees (gas + 30%).
  const feeAfter = await publicClient.getBalance({ address: recipientOfFees });
  const delta = feeAfter - feeBefore;
  log("Fee recipient balance AFTER", `${formatEther(feeAfter)} BNB`);
  log("Fees collected to recipient this run", `${formatEther(delta)} BNB`);

  console.log("\n=== ALL DONE (hosted relay) ===");
  console.log(`Wallet: https://testnet.bscscan.com/address/${wallet.address}`);
}

// Guarded so `sweepBack` can be imported and exercised on its own: the sweep
// is the one part of this script that must work the first time it runs.
if (import.meta.main) {
  main().catch((err) => {
    console.error("\n!!! FAILED");
    console.error(err);
    process.exit(1);
  });
}
