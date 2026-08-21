/**
 * Testnet demo: an agent wallet doing real, repeated work on an L2.
 *
 * Creates a wallet, gives an agent a scoped session key, then has that agent send
 * a SERIES of transactions on Base Sepolia — each one authorized by the L1 KeyStore
 * on Sepolia rather than by anything local. Then revokes on L1 and shows the agent
 * stop mid-stream.
 *
 * This is the demo version of live-gate-testnet.ts: same machinery, but it runs a
 * realistic burst of activity and prints explorer links for everything, so the
 * result can be inspected rather than taken on trust.
 *
 *   ALTANA_TESTNET_KEY=0x... SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co \
 *     bun run --filter '@altananetwork/e2e' demo:gate-testnet
 *
 * Optional: TX_COUNT (default 5).
 */
import {
  createClient,
  createPrivateKeySigner,
  signerFromPrivateKey,
  ensureKeyCached,
  syncKeyToL2,
  assertGateCompatiblePermissions,
  SEPOLIA,
  BASE_SEPOLIA,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TARGET: Address = "0x000000000000000000000000000000000000cafe";
const TX_COUNT = Number(process.env.TX_COUNT ?? 5);

const CAN_EXECUTE_ABI = [
  {
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

function keyHashFor(sessionAddress: Address): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "address" }], [sessionAddress]),
  );
  return keccak256(
    encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [2, inner]),
  );
}

async function main() {
  const adminKey = process.env.ALTANA_TESTNET_KEY as Hex | undefined;
  if (!adminKey) throw new Error("set ALTANA_TESTNET_KEY (must be a FRESH EOA)");
  const l1Rpc = process.env.SEPOLIA_RPC_URL ?? SEPOLIA.publicRpcUrl;
  // The Altana explorer's Base Sepolia indexer is pointed at the ORIGINAL cache,
  // so activity only appears there if we populate that address. Overridable for
  // that reason. Note the original cache is VERSION 1.1.0 and does not enforce
  // session-key expiry - revocation still works, expiry does not.
  const cache = (process.env.CACHE_ADDRESS ??
    BASE_SEPOLIA.keyStoreCache) as Address;
  const gate = (process.env.GATE_ADDRESS ??
    BASE_SEPOLIA.keyStoreCacheGate!) as Address;
  if (cache.toLowerCase() !== BASE_SEPOLIA.keyStoreCache.toLowerCase()) {
    console.log(`NOTE: using cache ${cache} (not the configured one).`);
    console.log("      If this is the 1.1.0 cache, expiry is NOT enforced.");
  }

  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [SEPOLIA, BASE_SEPOLIA] });
  const l1 = createPublicClient({ chain: SEPOLIA.chain, transport: http(l1Rpc) });
  const l2 = createPublicClient({
    chain: BASE_SEPOLIA.chain,
    transport: http(BASE_SEPOLIA.publicRpcUrl),
  });
  const l2Wallet = createWalletClient({
    account: privateKeyToAccount(adminKey),
    chain: BASE_SEPOLIA.chain,
    transport: http(BASE_SEPOLIA.publicRpcUrl),
  });

  console.log("\n--- 1. create an agent wallet -------------------------------");
  const wallet = await client.createWallet({ signer: admin });
  console.log(`wallet   ${wallet.address}`);
  console.log(`explorer https://testnet.altana.network/account/${wallet.address}`);

  console.log("\n--- 2. hire an agent: grant it a scoped session key ---------");
  const permissions = { spend: [{ limit: 10n ** 15n, period: "day" as const }] };
  assertGateCompatiblePermissions(permissions);
  const sessionSigner = createPrivateKeySigner();
  const session = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner,
    permissions,
    expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    chainId: SEPOLIA.chainId,
  });
  const keyId = keccak256(session.publicKey);
  const keyHash = keyHashFor(sessionSigner.address as Address);
  console.log(`agent key ${sessionSigner.address}`);
  console.log(`keyId     ${keyId}`);
  console.log(`registered on Sepolia: ${SEPOLIA.explorer}/address/${SEPOLIA.keyStore}`);
  console.log(`key page: https://testnet.altana.network/key/${keyId}`);

  console.log("\n--- 3. put the agent under L1 authority on Base Sepolia -----");
  // One relayed intent through the SDK: authorize the agent key on the L2
  // account, bound it, route TARGET through the gate, link to the L1 keyId. No
  // raw 7702 tx, no funded L2 signer for this step.
  const wired = await client.wireSessionToGate({
    wallet,
    signer: admin,
    session,
    chainId: BASE_SEPOLIA.chainId,
    gate,
    target: TARGET,
  });
  console.log(
    `  wired via relay: ${BASE_SEPOLIA.explorer}/tx/${wired.transactionHash ?? wired.callsId}`,
  );

  console.log("\n--- 4. activate on Base Sepolia (bridge the L1 proof) -------");
  await ensureKeyCached({
    l1Client: l1 as never,
    l2Client: l2 as never,
    l2WalletClient: l2Wallet as never,
    l1KeyStore: SEPOLIA.keyStore as Address,
    l2Cache: cache,
    user: wallet.address,
    publicKey: session.publicKey,
    onStatus: (s: string) => console.log(`  ${s}`),
  });

  console.log(`\n--- 5. the agent works: ${TX_COUNT} transactions ------------`);
  const hashes: Hex[] = [];
  for (let i = 1; i <= TX_COUNT; i++) {
    // Every execution is authorized by the L1 record, re-proven as needed.
    await ensureKeyCached({
      l1Client: l1 as never,
      l2Client: l2 as never,
      l2WalletClient: l2Wallet as never,
      l1KeyStore: SEPOLIA.keyStore as Address,
      l2Cache: cache,
      user: wallet.address,
      publicKey: session.publicKey,
    });
    // The proof is only valid for the exact L1 block the L2 anchors, and that
    // anchor rotates about every 12s - often faster than the relay can build and
    // land the intent. So a gated execution can lose the race and come back as
    // UnauthorizedCall. Re-prove and retry; this is the cost of populate and
    // execute being separate transactions rather than bundled.
    let h: Hex | undefined;
    for (let attempt = 1; attempt <= 6 && !h; attempt++) {
      try {
        const r = await client.execute({
          session,
          chainId: BASE_SEPOLIA.chainId,
          calls: [{ to: TARGET, value: BigInt(i), data: "0x" }],
        });
        h = r?.transactionHash as Hex;
      } catch (e) {
        if (!String(e).includes("UnauthorizedCall")) throw e;
        console.log(`     anchor moved, re-proving (attempt ${attempt})`);
        await syncKeyToL2({
          l1Client: l1 as never,
          l2Client: l2 as never,
          l2WalletClient: l2Wallet as never,
          l1KeyStore: SEPOLIA.keyStore as Address,
          l2Cache: cache,
          user: wallet.address,
          publicKey: session.publicKey,
        }).catch(() => {});
      }
    }
    if (!h) throw new Error(`tx ${i} never landed inside an anchor window`);
    hashes.push(h);
    console.log(`  tx ${i}/${TX_COUNT}  ${BASE_SEPOLIA.explorer}/tx/${h}`);
  }

  console.log("\n--- 6. fire the agent: revoke on Ethereum -------------------");
  await client.revokeSession({
    wallet,
    signer: admin,
    session,
    chainId: SEPOLIA.chainId,
  });
  console.log("  revoked on Sepolia");
  for (let i = 0; ; i++) {
    try {
      await syncKeyToL2({
        l1Client: l1 as never,
        l2Client: l2 as never,
        l2WalletClient: l2Wallet as never,
        l1KeyStore: SEPOLIA.keyStore as Address,
        l2Cache: cache,
        user: wallet.address,
        publicKey: session.publicKey,
      });
      break;
    } catch (e) {
      if (i >= 8) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }

  let allowed = true;
  for (let i = 0; i < 10 && allowed; i++) {
    allowed = (await l2.readContract({
      address: wallet.address,
      abi: CAN_EXECUTE_ABI,
      functionName: "canExecute",
      args: [keyHash, TARGET, "0x"],
    })) as boolean;
    if (allowed) await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`  agent authorized on Base Sepolia now: ${allowed}`);

  let stopped = false;
  try {
    await client.execute({
      session,
      chainId: BASE_SEPOLIA.chainId,
      calls: [{ to: TARGET, value: 1n, data: "0x" }],
    });
  } catch {
    stopped = true;
  }
  console.log(`  a further agent transaction was rejected: ${stopped}`);

  console.log("\n--- summary -------------------------------------------------");
  console.log(`wallet:     ${wallet.address}`);
  console.log(`agent txs:  ${hashes.length} on Base Sepolia`);
  console.log(`account:    https://testnet.altana.network/account/${wallet.address}`);
  console.log(`key:        https://testnet.altana.network/key/${keyId}`);
  console.log(`onchain:    ${BASE_SEPOLIA.explorer}/address/${wallet.address}`);
  if (!stopped || allowed) {
    console.log("\nWARNING: the agent was not stopped by the L1 revocation.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
