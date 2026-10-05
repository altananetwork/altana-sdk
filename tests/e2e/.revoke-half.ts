/**
 * Continues live-hypersigner-celo-cache from step 7 on the wallet the first run
 * left in place: valid on Celo, key live on the L1. Revokes on Sepolia, shows
 * Celo still holding the live entry, proves the revocation across, shows Celo
 * recording it.
 */
import { createPublicClient, createWalletClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celoSepolia, sepolia } from "viem/chains";
import { waitForL1Anchor } from "@altananetwork/sdk";
import { buildRevokeCall, deriveKeyId, readIsValidKey, resolveChain } from "@altananetwork/hypersigner-keystore-mcp/keystore";
import { encodeCacheProof, readCacheStatus } from "@altananetwork/hypersigner-keystore-mcp/cache";

const CHAIN = resolveChain("celo-sepolia");
const L2 = CHAIN.l2!;
const l1 = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL || CHAIN.rpcUrl) }) as PublicClient;
const l2 = createPublicClient({ chain: celoSepolia, transport: http(process.env.CELO_SEPOLIA_RPC_URL || L2.rpcUrl) }) as PublicClient;

const owner = privateKeyToAccount(process.env.HYPERSIGNER_CELO_82331A69_KEY as Hex);
const PUBKEY = "0x0428f2159afd648fb02b9aee52799dc01c4bbb7535b33eee3157f3591b2c9fcca8965cabe47bf5153a3d887a1cd2c21615b2d38b325ca28c318f9950628d04453e" as Hex;
const keyId = deriveKeyId(PUBKEY);
const ownerL1 = createWalletClient({ account: owner, chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL || CHAIN.rpcUrl) });
const ownerL2 = createWalletClient({ account: owner, chain: celoSepolia, transport: http(process.env.CELO_SEPOLIA_RPC_URL || L2.rpcUrl) });

const assert = (c: boolean, m: string) => { if (!c) throw new Error(`ASSERT FAILED: ${m}`); };
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const status = () => readCacheStatus({ chain: CHAIN, user: owner.address, keyId, client: l2 });

console.log(`owner ${owner.address}  key ${keyId}`);

const before = await status();
console.log(`\n[6] keystore_cache_status: valid=${before.valid} stale=${before.stale} cached at ${before.cached?.sourceBlockNumber}, anchor ${before.anchor.number}`);
assert(before.valid, `the key is valid on Celo Sepolia (${show(before)})`);

console.log("\n[7] keystore_encode_revoke_key, signed and sent by the owner");
const call = buildRevokeCall({ chain: CHAIN, user: owner.address, keyId });
const revokeHash = await ownerL1.sendTransaction({ to: call.to, value: call.value, data: call.data, account: owner, chain: sepolia });
const revokeReceipt = await l1.waitForTransactionReceipt({ hash: revokeHash });
assert(revokeReceipt.status === "success", "the revoke confirmed");
console.log(`    ${CHAIN.explorerUrl}/tx/${revokeHash} (block ${revokeReceipt.blockNumber})`);
assert(!(await readIsValidKey(l1, CHAIN, owner.address, keyId)), "the L1 registry now refuses the key");
console.log("    the L1 registry now refuses it");

const during = await status();
console.log(`\n[8] keystore_cache_status straight after: valid=${during.valid} stale=${during.stale} revoked=${during.cached?.revoked}`);
console.log(`    ${during.advice}`);
assert(during.cached?.revoked === false, "Celo still holds the live entry: a revocation does not cross by itself");

console.log("\n[9] keystore_encode_cache_proof (revocation)");
console.log(`    waiting for the anchor to reach ${revokeReceipt.blockNumber}`);
const anchor = await waitForL1Anchor({ l1Client: l1, l2Client: l2, targetL1Block: revokeReceipt.blockNumber, pollIntervalMs: 15_000, timeoutMs: 60 * 60_000, label: "celo sepolia anchor" });
console.log(`    L2 now anchors ${anchor.number}`);
for (let attempt = 1; attempt <= 5; attempt++) {
  const proof = await encodeCacheProof({ chain: CHAIN, user: owner.address, publicKey: PUBKEY, l1Client: l1, client: l2 });
  console.log(`    proof against L1 block ${proof.l1BlockNumber}, slot ${proof.provenKeySlot}`);
  if (proof.warning) { console.log(`    ${proof.warning.split(".")[0]}.`); await new Promise(r => setTimeout(r, 30_000)); continue; }
  try {
    const h = await ownerL2.sendTransaction({ to: proof.call.to, value: proof.call.value, data: proof.call.data, account: owner, chain: celoSepolia });
    const r = await l2.waitForTransactionReceipt({ hash: h });
    assert(r.status === "success", "the proof confirmed");
    console.log(`    relayed: ${L2.explorerUrl}/tx/${h}`);
    break;
  } catch (e) {
    console.log(`    attempt ${attempt} failed: ${(e as Error).message.split("\n")[0]}`);
    if (attempt === 5) throw e;
    await new Promise(r => setTimeout(r, 30_000));
  }
}

// The read lags the receipt: poll until the cache shows the revocation.
let final = await status();
for (let i = 0; i < 40 && final.cached?.revoked !== true; i++) {
  await new Promise(r => setTimeout(r, 3_000));
  final = await status();
}
console.log(`\n[10] keystore_cache_status: valid=${final.valid} revoked=${final.cached?.revoked} cached at ${final.cached?.sourceBlockNumber}`);
console.log(`     ${final.advice}`);
assert(final.cached?.revoked === true, `Celo's cache records the revocation (${show(final)})`);
assert(!final.valid, "and refuses the key");
console.log("\nResult: PASS — valid on Celo after a proof, revoked on Celo after another.");
