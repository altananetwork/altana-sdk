// End-to-end test of @altananetwork/sdk against local BNB testnet relay.
// Uses private-key signer (no passkey / WebAuthn) but exercises same relay
// flow and same on-chain contracts as the demo.

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

const log = (label: string, value?: any) => {
  console.log(`\n=== ${label} ===`);
  if (value !== undefined) console.log(value);
};

const DEPLOYER_PK = process.env.DEPLOYER_KEY as `0x${string}`;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_KEY env var not set");

const publicClient = createPublicClient({
  chain: bscTestnet,
  transport: http(BNB_TESTNET.publicRpcUrl),
});

async function main() {
  // 1. Fund a fresh EOA so it can pay the KeyStore registration fee.
  const adminPk = generatePrivateKey();
  const adminAccount = privateKeyToAccount(adminPk);
  log("Fresh admin EOA", adminAccount.address);

  const deployerWallet = createWalletClient({
    account: privateKeyToAccount(DEPLOYER_PK),
    chain: bscTestnet,
    transport: http(BNB_TESTNET.publicRpcUrl),
  });

  const fundAmount = parseEther("0.01");
  log("Funding admin from deployer", `${formatEther(fundAmount)} BNB`);
  const fundTx = await deployerWallet.sendTransaction({
    to: adminAccount.address,
    value: fundAmount,
  });
  log("Fund tx", fundTx);
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  const balance = await publicClient.getBalance({ address: adminAccount.address });
  log("Admin balance after funding", `${formatEther(balance)} BNB`);

  // 2. Client configured for BNB only, then createWallet — counterfactual
  //    setup, doesn't broadcast yet.
  log("Step 1: createWallet (counterfactual)");
  const client = createClient({ chains: [BNB_TESTNET] });
  const adminSigner = signerFromPrivateKey(adminPk);
  const wallet = await client.createWallet({
    signer: adminSigner,
  });
  log("Wallet handle", { address: wallet.address, chainId: BNB_TESTNET.chainId });

  // 3. grantSession — first on-chain action.
  log("Step 2: grantSession (FIRST on-chain action)");
  const recipientForSession = "0x000000000000000000000000000000000000dEaD" as const;
  const session = await client.grantSession({
    wallet,
    signer: adminSigner,
    sessionSigner: createPrivateKeySigner(),
    permissions: {
      calls: [{ to: recipientForSession }],
      spend: [{ limit: parseEther("0.001"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });
  log("Session granted", { sessionPubKey: session.signer.publicKey });

  // 4. Verify on-chain state.
  log("Step 3: verify on-chain");
  const walletCode = await publicClient.getCode({ address: wallet.address });
  log(
    "Wallet now has 7702 delegation code?",
    walletCode && walletCode !== "0x" ? "YES" : "NO",
  );

  const keyStoreActiveKeys = (await publicClient.readContract({
    address: BNB_TESTNET.keyStore,
    abi: [
      {
        name: "getKeys",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "user", type: "address" }],
        outputs: [{ name: "", type: "bytes32[]" }],
      },
    ] as const,
    functionName: "getKeys",
    args: [wallet.address],
  })) as readonly `0x${string}`[];
  log("Active keys in KeyStore for wallet", keyStoreActiveKeys);

  // 5. execute — session signs and submits a tx.
  log("Step 4: execute as session (grantSession should have waited until visible)");
  const execResult = await client.execute({
    session,
    calls: {
      to: recipientForSession,
      value: 1n,
      data: "0x",
    },
  });
  log("Execute result", {
    status: execResult.status,
    txHash: execResult.transactionHash,
  });

  // 6. revokeSession.
  log("Step 5: revokeSession");
  const revoke = await client.revokeSession({
    wallet,
    signer: adminSigner,
    session,
  });
  log("Revoke result", {
    status: revoke.status,
    txHash: revoke.transactionHash,
  });

  // 7. Final state check.
  const finalActiveKeys = (await publicClient.readContract({
    address: BNB_TESTNET.keyStore,
    abi: [
      {
        name: "getKeys",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "user", type: "address" }],
        outputs: [{ name: "", type: "bytes32[]" }],
      },
    ] as const,
    functionName: "getKeys",
    args: [wallet.address],
  })) as readonly `0x${string}`[];
  log("Active keys after revoke", finalActiveKeys);

  console.log("\n=== ALL DONE ===");
  console.log(`Wallet: https://testnet.bscscan.com/address/${wallet.address}`);
}

main().catch((err) => {
  console.error("\n!!! FAILED");
  console.error(err);
  process.exit(1);
});
