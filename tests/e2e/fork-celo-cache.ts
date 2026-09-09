/**
 * FORK E2E: the Celo Sepolia KeyStore cache accepts a real Sepolia proof
 * built by the SDK, and the SDK's cached-registry plumbing reads it back.
 *
 * Runs against an anvil fork of Celo Sepolia (real OP-stack `L1Block`
 * predeploy) with the released KeyStoreCacheOPStack 1.1.1 (bytecode compiled
 * from altana-keystore `main`, see fixtures/KeyStoreCacheOPStack-1.1.1.json)
 * deployed on the fork and anchored to the Sepolia KeyStore that
 * `CELO_SEPOLIA.registry.l1` names:
 *
 *   1. Deploys the cache with the Sepolia KeyStore as constructor argument
 *      and checks `VERSION()` and `l1KeyStore()`.
 *   2. Pins the fork's `L1Block` predeploy to a fresh Sepolia block (a few
 *      blocks behind head, so the proof RPC still serves it) by writing the
 *      predeploy's storage, exactly as the sequencer would have.
 *   3. Takes a wallet registered on the real Sepolia KeyStore, builds the
 *      `populateKey` call with the SDK (`buildPopulateKeyCall`: header RLP,
 *      account proof, storage proof, all at the anchored block) and sends it
 *      from a funded EOA on the fork.
 *   4. Asserts `isValidKey` is true (through the SDK's `isCachedKeyValid`),
 *      the cached struct matches the registry, and `computeKeyPackedSlot`
 *      matches the contract's `keyPackedSlot`.
 *   5. Moves the anchor one block and asserts the cache reports the entry as
 *      stale (`isValidKey` reverts, mapped to false), the freshness rule the
 *      SDK's design notes rely on.
 *   6. On the SDK side: `keyStoreCacheOf` refuses the not-deployed sentinel and
 *      accepts the fork's address; `submitCalls` refuses a registry call aimed
 *      at Celo Sepolia.
 *
 * Env:
 *   CELO_SEPOLIA_FORK_RPC_URL  Celo Sepolia RPC to fork (default: public Ankr).
 *   SEPOLIA_RPC_URL            Sepolia RPC with historical eth_getProof
 *                              (default: Tenderly's public gateway;
 *                              https://1rpc.io/sepolia also works; publicnode
 *                              only serves proofs for its newest block).
 *   CELO_FORK_PROOF_USER       A wallet registered on the Sepolia KeyStore
 *                              (default: one registered in Aug 2026).
 *
 * Before deploying its own cache it also reads the LIVE Celo Sepolia cache
 * (CELO_SEPOLIA.registry.keyStoreCache) on the fork: version, anchor, and the
 * first key ever proven into it (the deployer's root key), so a redeploy or a
 * wrong address in the config fails here rather than in a user's grant.
 *
 * Run: bun run fork:celo-cache   (from tests/e2e; needs `anvil`)
 */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  pad,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { celoSepolia } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CELO_SEPOLIA,
  SEPOLIA,
  buildPopulateKeyCall,
  computeKeyPackedSlot,
  isCachedKeyValid,
  keyStoreCacheOf,
  readCachedKey,
  readL1Anchor,
  createPrivateKeySigner,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { buildRelayClient, submitCalls } from "../../packages/wallet/src/internal/relay.js";
import { buildAdditionalRegisterCall } from "../../packages/wallet/src/internal/keystore.js";
import cacheArtifact from "./fixtures/KeyStoreCacheOPStack-1.1.1.json" with { type: "json" };

// `||`, not `??`: an unset GitHub Actions secret arrives as an empty string.
const CELO_RPC = process.env.CELO_SEPOLIA_FORK_RPC_URL || "https://rpc.ankr.com/celo_sepolia";
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://sepolia.gateway.tenderly.co";
const PROOF_USER = (process.env.CELO_FORK_PROOF_USER || "0xD035abdb79eDb8F868319F8B3FB3a2fb51032cB8") as Address;
const ANVIL_PORT = 8557;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const L1_BLOCK_PREDEPLOY: Address = "0x4200000000000000000000000000000000000015";
/** First key proven into the live Celo Sepolia cache (2026-09-09): the testnet deployer's root key. */
const LIVE_CACHED_USER: Address = "0x6A75e80B961f7d884f9D03E5Aa0808d05e47c50d";
const LIVE_CACHED_KEY_ID: Hex = "0x26aaf13c72b195571d3d7587c9df471e3f0752fb297da285e961267ac898e87d";

const KEYSTORE_ABI = [
  { name: "getKeys", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bytes32[]" }] },
  { name: "isValidKey", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { name: "getPublicKey", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }], outputs: [{ type: "bytes" }] },
  {
    name: "getKey", type: "function", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [
      { name: "validator", type: "address" }, { name: "publicKey", type: "bytes" }, { name: "metadata", type: "bytes" },
      { name: "nonce", type: "uint64" }, { name: "lastUpdated", type: "uint64" }, { name: "revoked", type: "bool" },
      { name: "expiry", type: "uint40" }, { name: "isRoot", type: "bool" },
    ] }],
  },
] as const;

const CACHE_ABI = [
  { name: "VERSION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "l1KeyStore", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "keyPackedSlot", type: "function", stateMutability: "pure", inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }], outputs: [{ type: "bytes32" }] },
  { name: "getKeys", type: "function", stateMutability: "view", inputs: [{ name: "user", type: "address" }], outputs: [{ type: "bytes32[]" }] },
  { name: "l1BlockNumber", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
] as const;

const test = createTestClient({ mode: "anvil", chain: celoSepolia, transport: http(ANVIL_URL) });
// Typed as plain PublicClients: viem's celoSepolia carries Celo-specific
// formatters, and the SDK's helpers take the generic client type.
const l2: PublicClient = createPublicClient({ chain: celoSepolia as Chain, transport: http(ANVIL_URL) });
const l1: PublicClient = createPublicClient({ chain: SEPOLIA.chain, transport: http(SEPOLIA_RPC) });

function log(msg: string) { console.log(msg); }
function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`ASSERT FAILED: ${msg}`); }
async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    try { await l2.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("anvil not ready");
}

async function main() {
  log(`\n▶ Booting anvil Celo Sepolia fork (${ANVIL_URL}) from ${CELO_RPC.replace(/\/[^/]*$/, "/…")} ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", CELO_RPC, "--port", String(ANVIL_PORT), "--silent"], { stdout: "ignore", stderr: "ignore" });
  try {
    await waitForAnvil();
    assert((await l2.getChainId()) === CELO_SEPOLIA.chainId, "fork is Celo Sepolia (11142220)");
    const liveAnchor = await readL1Anchor(l2);
    log(`  fork block ${await l2.getBlockNumber()}, L1Block anchors Sepolia #${liveAnchor.number}`);

    // ── 0. The live cache the SDK config points at. ──
    log("\n▶ Reading the live Celo Sepolia cache from the SDK config ...");
    const liveCache = keyStoreCacheOf(CELO_SEPOLIA);
    assert((await l2.getCode({ address: liveCache })) !== undefined, `code at CELO_SEPOLIA.registry.keyStoreCache (${liveCache})`);
    const liveVersion = await l2.readContract({ address: liveCache, abi: CACHE_ABI, functionName: "VERSION" });
    const liveL1 = await l2.readContract({ address: liveCache, abi: CACHE_ABI, functionName: "l1KeyStore" });
    assert(liveVersion === "1.1.1", `live cache VERSION is 1.1.1 (got ${liveVersion})`);
    assert(liveL1.toLowerCase() === SEPOLIA.keyStore.toLowerCase(), "live cache is anchored to CELO_SEPOLIA.registry.l1.keyStore");
    const liveEntry = await readCachedKey(l2, liveCache, LIVE_CACHED_USER, LIVE_CACHED_KEY_ID);
    assert(liveEntry.publicKey.length > 2 && keccak256(liveEntry.publicKey) === LIVE_CACHED_KEY_ID, "the first proven key is cached with keyId == keccak256(publicKey)");
    assert(liveEntry.isRoot && !liveEntry.revoked && liveEntry.expiry === 0, "it is a live root key");
    const liveKeys = await l2.readContract({ address: liveCache, abi: CACHE_ABI, functionName: "getKeys", args: [LIVE_CACHED_USER] });
    assert(liveKeys.includes(LIVE_CACHED_KEY_ID), "live cache.getKeys lists it");
    assert(await l1.readContract({ address: SEPOLIA.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey", args: [LIVE_CACHED_USER, LIVE_CACHED_KEY_ID] }), "and the Sepolia registry agrees (isValidKey true)");
    log(`  ✓ ${liveCache} VERSION ${liveVersion}; ${LIVE_CACHED_USER} root key cached at Sepolia #${liveEntry.sourceBlockNumber}, registry agrees`);

    // ── 1. Deploy KeyStoreCacheOPStack 1.1.1 anchored to the Sepolia KeyStore. ──
    log("\n▶ Deploying KeyStoreCacheOPStack 1.1.1 (bytecode from altana-keystore main) ...");
    const deployer = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: deployer.address, value: 10n ** 20n });
    const deployerWallet = createWalletClient({ account: deployer, chain: celoSepolia, transport: http(ANVIL_URL) });
    const deployHash = await deployerWallet.deployContract({
      abi: cacheArtifact.abi as never,
      bytecode: cacheArtifact.bytecode as Hex,
      args: [SEPOLIA.keyStore],
    } as never);
    const deployReceipt = await l2.waitForTransactionReceipt({ hash: deployHash });
    assert(deployReceipt.status === "success" && !!deployReceipt.contractAddress, "cache deployed");
    const cache = deployReceipt.contractAddress!;
    const version = await l2.readContract({ address: cache, abi: CACHE_ABI, functionName: "VERSION" });
    const l1KeyStore = await l2.readContract({ address: cache, abi: CACHE_ABI, functionName: "l1KeyStore" });
    assert(version === "1.1.1", `cache VERSION is 1.1.1 (got ${version})`);
    assert(l1KeyStore.toLowerCase() === SEPOLIA.keyStore.toLowerCase(), "cache anchored to the Sepolia KeyStore");
    log(`  ✓ cache ${cache} VERSION ${version}, l1KeyStore ${l1KeyStore}`);

    // The SDK config with the fork's cache filled in: what CELO_SEPOLIA looks
    // like once the deployment address is published.
    const network: NetworkConfig = {
      ...CELO_SEPOLIA,
      publicRpcUrl: ANVIL_URL,
      registry: { kind: "cached", l1: SEPOLIA, keyStoreCache: cache },
    };
    let refused = "";
    try { keyStoreCacheOf({ ...CELO_SEPOLIA, registry: { kind: "cached", l1: SEPOLIA, keyStoreCache: "0x0000000000000000000000000000000000000000" } }); } catch (e) { refused = (e as Error).message; }
    assert(/not deployed/.test(refused), "keyStoreCacheOf refuses the not-deployed sentinel");
    assert(keyStoreCacheOf(network) === cache, "keyStoreCacheOf returns the fork's address");

    // ── 2. Pin the anchor to a fresh Sepolia block. ──
    // Proof RPCs keep only a short window of state; the fork's own anchor may
    // already be outside it by the time the proof is fetched. Write the
    // predeploy's storage (slot 0: number | timestamp << 64, slot 2: hash),
    // which is what the sequencer's setL1BlockValues does.
    log("\n▶ Anchoring the fork to a fresh Sepolia block ...");
    const l1Head = await l1.getBlockNumber();
    const target = await l1.getBlock({ blockNumber: l1Head - 2n });
    const slot0 = pad(toHex((target.timestamp << 64n) | target.number), { size: 32 });
    await test.setStorageAt({ address: L1_BLOCK_PREDEPLOY, index: 0, value: slot0 });
    await test.setStorageAt({ address: L1_BLOCK_PREDEPLOY, index: 2, value: target.hash });
    const anchor = await readL1Anchor(l2);
    assert(anchor.hash === target.hash && anchor.number === target.number, "predeploy reports the pinned block");
    log(`  ✓ L1Block now anchors Sepolia #${anchor.number} (${anchor.hash.slice(0, 14)}…)`);

    // ── 3. A wallet registered on the real Sepolia KeyStore. ──
    log(`\n▶ Reading the registry entry for ${PROOF_USER} on Sepolia ...`);
    const keyIds = await l1.readContract({ address: SEPOLIA.keyStore, abi: KEYSTORE_ABI, functionName: "getKeys", args: [PROOF_USER] });
    assert(keyIds.length > 0, "proof user has keys on the Sepolia KeyStore (set CELO_FORK_PROOF_USER to a registered wallet)");
    let keyId: Hex | undefined;
    for (const id of keyIds) {
      if (await l1.readContract({ address: SEPOLIA.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey", args: [PROOF_USER, id] })) { keyId = id; break; }
    }
    assert(!!keyId, "proof user has a currently valid key");
    const publicKey = await l1.readContract({ address: SEPOLIA.keyStore, abi: KEYSTORE_ABI, functionName: "getPublicKey", args: [PROOF_USER, keyId!] });
    const record = await l1.readContract({ address: SEPOLIA.keyStore, abi: KEYSTORE_ABI, functionName: "getKey", args: [PROOF_USER, keyId!] });
    assert(keccak256(publicKey) === keyId, "keyId == keccak256(publicKey) (SDK convention the cache enforces)");
    log(`  ✓ keyId ${keyId!.slice(0, 14)}… root=${record.isRoot} expiry=${record.expiry} revoked=${record.revoked}`);

    // The slot the SDK proves is the slot the contract reads.
    const contractSlot = await l2.readContract({ address: cache, abi: CACHE_ABI, functionName: "keyPackedSlot", args: [PROOF_USER, keyId!] });
    assert(contractSlot === computeKeyPackedSlot(PROOF_USER, keyId!), "computeKeyPackedSlot matches KeyStoreCacheOPStack.keyPackedSlot");
    log("  ✓ computeKeyPackedSlot == cache.keyPackedSlot");

    // ── 4. Build the proof with the SDK and submit it. ──
    log("\n▶ buildPopulateKeyCall at the anchored block, sending from a funded EOA ...");
    const call = await buildPopulateKeyCall({
      l1Client: l1, l2Client: l2, l1KeyStore: SEPOLIA.keyStore, l2Cache: cache, user: PROOF_USER, publicKey,
    });
    assert(call.l1BlockNumber === anchor.number, "proof built against the anchored block");
    const submitter = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: submitter.address, value: 10n ** 20n });
    const submitterWallet = createWalletClient({ account: submitter, chain: celoSepolia, transport: http(ANVIL_URL) });
    const proofHash = await submitterWallet.sendTransaction({ to: call.to, data: call.data, value: call.value, gas: 3_000_000n });
    const proofReceipt = await l2.waitForTransactionReceipt({ hash: proofHash });
    assert(proofReceipt.status === "success", "populateKey landed");
    log(`  ✓ populateKey mined in fork block ${proofReceipt.blockNumber} (gas ${proofReceipt.gasUsed})`);

    const valid = await isCachedKeyValid(l2, cache, PROOF_USER, keyId!);
    assert(valid === true, "cache.isValidKey(user, keyId) is true right after the proof");
    const cached = await readCachedKey(l2, cache, PROOF_USER, keyId!);
    assert(cached.publicKey.toLowerCase() === publicKey.toLowerCase(), "cached publicKey matches the registry");
    assert(cached.revoked === record.revoked && cached.isRoot === record.isRoot && cached.expiry === record.expiry, "cached flags match the registry record");
    assert(cached.sourceBlockNumber === anchor.number && cached.sourceBlockHash === anchor.hash, "cache records the proven Sepolia block");
    const cachedKeys = await l2.readContract({ address: cache, abi: CACHE_ABI, functionName: "getKeys", args: [PROOF_USER] });
    assert(cachedKeys.includes(keyId!), "cache.getKeys lists the key");
    log(`  ✓ isValidKey true; getCachedKey: revoked=${cached.revoked} expiry=${cached.expiry} isRoot=${cached.isRoot} source #${cached.sourceBlockNumber}`);

    // ── 5. Freshness: once the anchor moves, the entry needs a new proof. ──
    log("\n▶ Moving the anchor one block: the cache must report the entry as stale ...");
    await test.setStorageAt({ address: L1_BLOCK_PREDEPLOY, index: 0, value: pad(toHex((target.timestamp << 64n) | (target.number + 1n)), { size: 32 }) });
    assert((await l2.readContract({ address: cache, abi: CACHE_ABI, functionName: "l1BlockNumber" })) === target.number + 1n, "anchor moved");
    assert((await isCachedKeyValid(l2, cache, PROOF_USER, keyId!)) === false, "isValidKey reverts on a stale entry and the SDK maps it to false");
    const still = await readCachedKey(l2, cache, PROOF_USER, keyId!);
    assert(still.publicKey.toLowerCase() === publicKey.toLowerCase() && !still.revoked, "getCachedKey keeps the proven state for inspection");
    log("  ✓ stale → isCachedKeyValid false, getCachedKey still readable");

    // ── 6. The SDK refuses registry calls aimed at Celo Sepolia. ──
    log("\n▶ submitCalls refuses a Sepolia registry call on Celo Sepolia ...");
    const admin = createPrivateKeySigner();
    const registerOnSepolia = buildAdditionalRegisterCall({ publicKey: admin.publicKey, fee: 200_000_000_000_000n, network: SEPOLIA });
    let refusal = "";
    try {
      await submitCalls(buildRelayClient(network), admin.address, admin, [registerOnSepolia], {
        feeToken: "0x0000000000000000000000000000000000000000",
        submittingKey: { type: "secp256k1", publicKey: admin.publicKey, role: "admin" },
        network,
      });
    } catch (e) { refusal = (e as Error).message; }
    assert(/KeyStoreController address of Sepolia/.test(refusal), `refused with the registry-target message (got: ${refusal.slice(0, 120)})`);
    assert((await l2.getCode({ address: CELO_SEPOLIA.keyStoreController })) === undefined, "and indeed there is no code at that address on Celo Sepolia");
    log("  ✓ refused before reaching the relay; no code at the Controller address on Celo Sepolia");

    // The encoded slot key is what eth_getProof was asked for.
    const slotKey = keccak256(encodeAbiParameters([{ type: "bytes32" }], [computeKeyPackedSlot(PROOF_USER, keyId!)]));
    log(`\n  (proved slot ${computeKeyPackedSlot(PROOF_USER, keyId!).slice(0, 14)}…, trie key ${slotKey.slice(0, 14)}…)`);
    log("\nResult: PASS ✓: KeyStoreCacheOPStack 1.1.1 on a Celo Sepolia fork accepted a real Sepolia proof built by the SDK; isValidKey true.\n");
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
