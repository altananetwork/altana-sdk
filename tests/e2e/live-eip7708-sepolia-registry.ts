/**
 * LIVE — a Sepolia KeyStore registry leg succeeds after EIP-7708, from a wallet
 * holding only CELO.
 *
 * This is the proof for the asset-diff sanitiser. Ethereum Sepolia activated
 * Glamsterdam at block 11856337, after which every ETH transfer also emits an
 * ERC-20 `Transfer` log from `0xff..fe`. The relay turned that into an
 * `assetDiffs` entry with `type: "erc20"` and no `symbol`, porto rejected the
 * whole `wallet_prepareCalls` response ("Validation failed with 3 errors"),
 * and every `grantSession` registry leg on Sepolia failed.
 *
 * Run against the relay that has interop on, because the registry write is
 * paid from the wallet's CELO:
 *   ALTANA_RELAY_URL=https://relay-staging-production-2657.up.railway.app
 *
 * What it asserts: the grant's **registry** leg reaches CONFIRMED, and the key
 * reads valid in the Sepolia KeyStore. On the unsanitised SDK the grant throws
 * before anything is signed, so a pass here is the fix working rather than a
 * difference of degree.
 *
 * Run: bun run live:eip7708-registry   (from tests/e2e)
 */
import {
  createClient,
  signerFromPrivateKey,
  waitForBalance,
  CELO_SEPOLIA,
  SEPOLIA,
  type NetworkConfig,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";
const CELO_FUNDING = parseEther("0.5");
/** Glamsterdam/EIP-7708 on Ethereum Sepolia, 2026-10-06 13:53:36 UTC. */
const FORK_BLOCK = 11856337n;

/**
 * One execution network, Celo Sepolia, with its registry chain pointed at the
 * same relay.
 *
 * Sepolia must NOT be passed in `chains`: that would make it an execution
 * network, so the SDK would open an account leg there and the wallet would need
 * Sepolia ETH -- the very thing this proves it does not. The registry chain
 * comes from `registry.l1`, and both it and the execution network need the
 * relay with interop on, because the Sepolia write is paid from the Celo
 * balance.
 */
const l1Read = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  relayUrl: RELAY,
  registry: {
    ...(CELO_SEPOLIA.registry as any),
    l1: { ...SEPOLIA, relayUrl: RELAY, publicRpcUrl: l1Read },
  },
} as NetworkConfig;
/**
 * `SEPOLIA.publicRpcUrl` is `https://0xrpc.io/sep`, which **did not upgrade for
 * Glamsterdam**: measured 2026-10-06, it is frozen at block 11856335
 * (13:53:12 UTC, 24 seconds before the fork) and does not have the fork block
 * at all, so every read through it returns pre-fork state, permanently. Until
 * the shipped default is changed, this test reads Sepolia through a node that
 * followed the fork. Override with SEPOLIA_RPC_URL.
 */
const l1: NetworkConfig = { ...SEPOLIA, relayUrl: RELAY, publicRpcUrl: l1Read };

const pub = createPublicClient({ chain: celoSepolia, transport: http(network.publicRpcUrl) }) as PublicClient;
const sep = createPublicClient({ transport: http(l1.publicRpcUrl) }) as PublicClient;

const KEYSTORE_ABI = [
  { name: "isValidKey", type: "function", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  console.log("LIVE: Sepolia registry leg after EIP-7708");
  console.log("=========================================\n");
  console.log(`relay ${RELAY}`);

  // The fork is what makes this test meaningful; say so if it has not happened.
  //
  // Read several times and keep the highest. The public Sepolia endpoint is
  // load-balanced and its backends disagree: one read here returned 11856335
  // while another, seconds later, returned 11856443 -- a backend ~100 blocks
  // behind. A single read would have reported the fork as not yet activated
  // nearly half an hour after it was.
  let head = 0n;
  for (let i = 0; i < 5; i++) {
    const seen = await sep.getBlockNumber({ cacheTime: 0 }).catch(() => 0n);
    if (seen > head) head = seen;
    if (head >= FORK_BLOCK) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log(`Sepolia head ${head} (Glamsterdam activated at ${FORK_BLOCK})`);
  assert(head >= FORK_BLOCK, "Sepolia is past the EIP-7708 fork block");

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const fw = createWalletClient({ account: funder, chain: celoSepolia, transport: http(network.publicRpcUrl) });

  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [network] });
  const wallet = await client.createWallet({ signer: admin });
  appendFileSync(
    testnetEnvFile(),
    `\n# live-eip7708-sepolia-registry wallet ${wallet.address}, ${new Date().toISOString()}\n` +
      `EIP7708_${wallet.address.slice(2, 10).toUpperCase()}_KEY=${adminKey}\n`,
  );
  console.log(`\nwallet ${wallet.address} (key saved before funding)`);

  // CELO only. No Sepolia ETH: the registry write is paid from this balance.
  const tx = await fw.sendTransaction({ to: wallet.address, value: CELO_FUNDING, account: funder, chain: celoSepolia });
  await pub.waitForTransactionReceipt({ hash: tx });
  await waitForBalance(pub, wallet.address, CELO_FUNDING, 120_000);
  const sepBefore = await sep.getBalance({ address: wallet.address });
  console.log(`funded ${formatUnits(CELO_FUNDING, 18)} CELO; Sepolia ETH before: ${formatUnits(sepBefore, 18)}`);
  assert(sepBefore === 0n, "the wallet holds no Sepolia ETH before the write");

  console.log("\ngrantSession with a registry leg on Sepolia");
  const granted = await client.grantSession({
    wallet,
    signer: admin,
    register: true,
    populateCache: false,
    permissions: { calls: [{ to: wallet.address }], spend: [{ limit: parseEther("0.1"), period: "day" }] },
    expiry: Math.floor(Date.now() / 1000) + 3600,
  });

  for (const leg of granted.legs) {
    console.log(`  ${leg.kind} on ${leg.chainId}: ${leg.status}${leg.transactionHash ? ` ${leg.transactionHash}` : ""}${(leg as any).via ? ` via ${(leg as any).via}` : ""}`);
  }
  assert(granted.status === "granted", `the grant succeeded (${granted.status})`);

  const registry = granted.legs.find((l) => l.kind === "registry");
  assert(registry !== undefined, "a registry leg was produced");
  assert(registry!.status === "CONFIRMED", `the registry leg is CONFIRMED (${registry!.status})`);

  const keyHash = (granted as any).keyHash ?? (granted as any).session?.keyHash;
  if (keyHash) {
    const valid = await sep.readContract({
      address: l1.keyStore as Address, abi: KEYSTORE_ABI, functionName: "isValidKey",
      args: [wallet.address, keyHash as Hex],
    });
    console.log(`  Sepolia KeyStore.isValidKey(${wallet.address}, ${String(keyHash).slice(0, 10)}…) = ${valid}`);
    assert(valid === true, "the key reads valid in the Sepolia KeyStore");
  }

  const sepAfter = await sep.getBalance({ address: wallet.address });
  console.log(`\nSepolia ETH after: ${formatUnits(sepAfter, 18)} (relay funds the write and refunds the change)`);
  console.log("\nResult: PASS ✓ a Sepolia registry leg confirms post-EIP-7708 from a CELO-only wallet.");
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  process.exit(1);
});
