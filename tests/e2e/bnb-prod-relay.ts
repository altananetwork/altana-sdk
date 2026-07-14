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
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

const log = (label: string, value?: unknown) => {
  console.log(`\n=== ${label} ===`);
  if (value !== undefined) console.log(value);
};

const RELAY_URL =
  process.env.RELAY_URL ?? "https://relay-testnet.altana.network";
const FEE_RECIPIENT = "0x20E8551E9B458AE2a92aFBDE787dD76e3702833f" as const;
const DEPLOYER_PK = process.env.DEPLOYER_KEY as `0x${string}`;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_KEY env var not set");

// BNB testnet config, but pointed at the hosted relay.
const BNB = { ...BNB_TESTNET, relayUrl: RELAY_URL };
const client = createClient({ chains: [BNB] });

const publicClient = createPublicClient({
  chain: bscTestnet,
  transport: http(BNB.publicRpcUrl),
});

async function main() {
  log("Hosted relay", RELAY_URL);
  const feeBefore = await publicClient.getBalance({ address: FEE_RECIPIENT });
  log("Fee recipient balance BEFORE", `${formatEther(feeBefore)} BNB`);

  // 1. Fund a fresh admin EOA from the deployer.
  const adminPk = generatePrivateKey();
  const adminAccount = privateKeyToAccount(adminPk);
  log("Fresh admin EOA", adminAccount.address);

  const deployerWallet = createWalletClient({
    account: privateKeyToAccount(DEPLOYER_PK),
    chain: bscTestnet,
    transport: http(BNB.publicRpcUrl),
  });
  const fundTx = await deployerWallet.sendTransaction({
    to: adminAccount.address,
    value: parseEther("0.01"),
  });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  log("Funded admin 0.01 BNB", fundTx);

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
  log("Revoke result", { status: revoke.status, txHash: revoke.transactionHash });

  // 6. Fee recipient delta — proves the relay collected fees (gas + 30%).
  const feeAfter = await publicClient.getBalance({ address: FEE_RECIPIENT });
  const delta = feeAfter - feeBefore;
  log("Fee recipient balance AFTER", `${formatEther(feeAfter)} BNB`);
  log("Fees collected to recipient this run", `${formatEther(delta)} BNB`);

  console.log("\n=== ALL DONE (hosted relay) ===");
  console.log(`Wallet: https://testnet.bscscan.com/address/${wallet.address}`);
}

main().catch((err) => {
  console.error("\n!!! FAILED");
  console.error(err);
  process.exit(1);
});
