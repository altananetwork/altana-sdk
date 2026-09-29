/**
 * LIVE (Celo Sepolia + Sepolia) — a key managed through hypersigner-keystore-mcp
 * becomes valid on Celo, and later reads as revoked there.
 *
 * hypersigner is non-custodial: it reads, and it encodes unsigned calls. So the
 * shape of this test is the shape of its promise. For every step, the MCP
 * server's own tools decide what to send, this script signs and sends it, and
 * the server's read tool says what the chains now think:
 *
 *   1. keystore_registration_quote      the Controller's fee, live
 *   2. keystore_encode_register_key     register a session key on Sepolia
 *   3. keystore_verify_authorization    the L1 registry says it is authorized
 *   4. keystore_cache_status            Celo has never heard of it
 *   5. keystore_encode_cache_proof      the populateKey call for Celo
 *   6. keystore_cache_status            Celo says it is valid
 *   7. keystore_encode_revoke_key       revoke it on Sepolia
 *   8. keystore_cache_status            Celo is stale, not yet revoked there
 *   9. keystore_encode_cache_proof      prove the revocation across
 *  10. keystore_cache_status            Celo says revoked
 *
 * Step 8 is the point of the whole exercise: a revocation on the L1 does not
 * reach the L2 by itself. Anything reading the Celo cache keeps seeing a live
 * key until someone relays the proof, and that window is a security property
 * worth being explicit about.
 *
 * The wallet here is a plain EOA registering its own key, which is what the
 * KeyStore Controller requires (`msg.sender` becomes the `user`) and what a
 * non-Altana agent SDK using this server would do. No relay and no Altana
 * account are involved.
 *
 * Needs:
 *   TEST_FUNDER_KEY        ETH on Sepolia (>= 0.05) and CELO on Celo Sepolia (>= 1)
 *
 * Budget an hour of wall clock. The L2 anchors the L1 with a lag and a proof
 * can only carry what the anchored block holds, so each of the two proofs waits
 * for the anchor to reach its write: on Celo Sepolia that is about half an hour
 * each, and the two are sequential because the revoke follows the first proof.
 *   SEPOLIA_RPC_URL        an RPC that serves eth_getProof for recent blocks
 *   CELO_SEPOLIA_RPC_URL   optional read RPC override
 *
 * Run: bun run live:hypersigner-celo   (from tests/e2e)
 */
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celoSepolia, sepolia } from "viem/chains";
import { waitForL1Anchor } from "@altananetwork/sdk";
import {
  buildRegisterCall,
  buildRevokeCall,
  deriveKeyId,
  readIsValidKey,
  readKey,
  readRegistrationFee,
  resolveChain,
  type Call,
} from "@altananetwork/hypersigner-keystore-mcp/keystore";
import { encodeCacheProof, readCacheStatus } from "@altananetwork/hypersigner-keystore-mcp/cache";
import { appendFileSync } from "node:fs";
import { testnetEnvFile } from "./testnet-env.js";

/** ALTANA_CHAIN=celo-sepolia: the Sepolia registry, naming Celo Sepolia's cache. */
const CHAIN = resolveChain("celo-sepolia");
const L2 = CHAIN.l2!;
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || CHAIN.rpcUrl;
const CELO_RPC = process.env.CELO_SEPOLIA_RPC_URL || L2.rpcUrl;

const l1 = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) }) as PublicClient;
const l2 = createPublicClient({ chain: celoSepolia, transport: http(CELO_RPC) }) as PublicClient;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

async function main() {
  console.log("LIVE hypersigner: an L1 key, made readable on Celo Sepolia");
  console.log("=========================================================\n");
  console.log(`registry ${CHAIN.chain.name} ${CHAIN.keyStore}`);
  console.log(`cache    ${L2.chain.name} ${L2.cache}`);

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const l1Funder = createWalletClient({ account: funder, chain: sepolia, transport: http(SEPOLIA_RPC) });
  const l2Funder = createWalletClient({ account: funder, chain: celoSepolia, transport: http(CELO_RPC) });

  // The account whose keys these are. A plain EOA: the Controller records
  // msg.sender as the user, so it signs its own registrations.
  const ownerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  saveKey(`hypersigner-celo owner ${owner.address}`, `HYPERSIGNER_CELO_${owner.address.slice(2, 10).toUpperCase()}_KEY`, ownerKey);
  const ownerL1 = createWalletClient({ account: owner, chain: sepolia, transport: http(SEPOLIA_RPC) });
  console.log(`owner    ${owner.address}`);

  // The key being managed. Only its public key matters on chain.
  const sessionKey = generatePrivateKey();
  const session = privateKeyToAccount(sessionKey);
  const publicKey = session.publicKey;
  const keyId = deriveKeyId(publicKey);
  console.log(`key      ${keyId} (${publicKey.slice(0, 20)}…)`);

  // ── 1. The fee, read live through the server's own helper. ──
  const fee = await readRegistrationFee(l1, CHAIN);
  console.log(`\n[1] keystore_registration_quote: ${formatEther(fee)} ETH per key`);

  // The owner needs the fee twice (root + session) plus gas, and CELO to relay
  // two proofs. Fund it, and wait for the balances rather than the receipts.
  await fund(l1Funder, l1, owner.address, fee * 2n + parseEther("0.02"), "Sepolia");
  await fund(l2Funder, l2, owner.address, parseEther("0.3"), "Celo Sepolia");

  // ── 2. Register. The root key is the owner's own; then the session key. ──
  console.log("\n[2] keystore_encode_register_key, signed and sent by the owner");
  await sendL1(ownerL1, l1, buildRegisterCall({ chain: CHAIN, publicKey: owner.publicKey, fee, role: "root" }), "root key");
  const registeredAt = await sendL1(
    ownerL1,
    l1,
    buildRegisterCall({ chain: CHAIN, publicKey, fee, role: "session", expiry: 0 }),
    "session key",
  );

  // ── 3. The L1 registry's own verdict. ──
  const validOnL1 = await readIsValidKey(l1, CHAIN, owner.address, keyId);
  const key = await readKey(l1, CHAIN, owner.address, keyId);
  console.log(`\n[3] keystore_verify_authorization on the L1: ${validOnL1}`);
  console.log(`    ${show(key)}`);
  assert(validOnL1, "the key is authorized in the Sepolia KeyStore");

  // ── 4. And Celo has never heard of it. ──
  const status = () => readCacheStatus({ chain: CHAIN, user: owner.address, keyId, client: l2 });

  const before = await status();
  console.log(`\n[4] keystore_cache_status: valid=${before.valid} absent=${before.absent} stale=${before.stale}`);
  console.log(`    ${before.advice}`);
  assert(before.absent && !before.valid, "Celo does not know the key before a proof is relayed");

  // ── 5 and 6. Prove it across, then ask Celo again. ──
  await relayProof("[5] keystore_encode_cache_proof (authorization)", owner.address, publicKey, l2Funder, registeredAt);
  const proven = await status();
  console.log(`\n[6] keystore_cache_status: valid=${proven.valid} absent=${proven.absent} stale=${proven.stale}`);
  console.log(`    cached at L1 block ${proven.cached?.sourceBlockNumber}, L2 anchors ${proven.anchor.number}`);
  assert(proven.valid, `the key is valid on Celo Sepolia after the proof (${show(proven)})`);
  console.log(`    ${L2.explorerUrl}/address/${L2.cache}`);

  // ── 7. Revoke on the L1. ──
  console.log("\n[7] keystore_encode_revoke_key, signed and sent by the owner");
  const revokedAt = await sendL1(ownerL1, l1, buildRevokeCall({ chain: CHAIN, user: owner.address, keyId }), "revoke");
  assert(!(await readIsValidKey(l1, CHAIN, owner.address, keyId)), "the L1 registry now refuses the key");
  console.log("    the L1 registry now refuses it");

  // ── 8. The window. Celo still has the old entry, and says so. ──
  const duringWindow = await status();
  console.log(`\n[8] keystore_cache_status straight after the revoke: valid=${duringWindow.valid} stale=${duringWindow.stale} revoked=${duringWindow.cached?.revoked}`);
  console.log(`    ${duringWindow.advice}`);
  assert(
    duringWindow.cached?.revoked === false,
    "Celo's cached entry still says the key is live: a revocation does not cross by itself",
  );

  // ── 9 and 10. Prove the revocation across. ──
  await relayProof("[9] keystore_encode_cache_proof (revocation)", owner.address, publicKey, l2Funder, revokedAt);
  const revoked = await status();
  console.log(`\n[10] keystore_cache_status: valid=${revoked.valid} revoked=${revoked.cached?.revoked}`);
  console.log(`     ${revoked.advice}`);
  assert(revoked.cached?.revoked === true, `Celo's cache records the revocation (${show(revoked)})`);
  assert(!revoked.valid, "and refuses the key");

  await sweep(owner, l2Funder);

  console.log("\n=========================================================");
  console.log("Result: PASS — valid on Celo after a proof, revoked on Celo after another.");
}

/** Signs and sends one encoded L1 call as the owner, and waits for it. */
async function sendL1(
  wallet: ReturnType<typeof createWalletClient>,
  client: PublicClient,
  call: Call,
  label: string,
): Promise<bigint> {
  assert(call.chainId === CHAIN.chainId, `${label} is encoded for the registry chain`);
  const hash = await wallet.sendTransaction({
    to: call.to,
    value: call.value,
    data: call.data,
    account: wallet.account!,
    chain: sepolia,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert(receipt.status === "success", `${label} confirmed (${hash})`);
  console.log(`    ${label}: ${CHAIN.explorerUrl}/tx/${hash} (block ${receipt.blockNumber})`);
  return receipt.blockNumber;
}

/** Encodes a cache proof with the server's own tool and relays it on the L2. */
async function relayProof(
  label: string,
  user: Address,
  publicKey: Hex,
  l2Wallet: ReturnType<typeof createWalletClient>,
  writtenAtL1Block: bigint,
) {
  console.log(`\n${label}`);
  // A proof can only carry what the anchored block already holds, and Celo
  // Sepolia's L1Block predeploy advances about every 20 minutes and trails
  // Sepolia by 15 to 20, so a fresh registry write takes close to half an hour
  // to become provable. Wait for the anchor to pass the write's block first.
  const anchor = await readCacheStatus({ chain: CHAIN, user, keyId: deriveKeyId(publicKey), client: l2 });
  if (anchor.anchor.number < writtenAtL1Block) {
    console.log(
      `    L2 anchors L1 block ${anchor.anchor.number}, the write is in ${writtenAtL1Block}: waiting for the anchor (up to 60 min)`,
    );
  }
  const reached = await waitForL1Anchor({
    l1Client: l1,
    l2Client: l2,
    targetL1Block: writtenAtL1Block,
    pollIntervalMs: 15_000,
    timeoutMs: 60 * 60_000,
    label: "celo sepolia anchor",
  });
  console.log(`    L2 now anchors L1 block ${reached.number}`);

  // The anchor keeps moving, and the cache only takes a proof against the block
  // it anchors right now, so encode and send together and retry on a lost race.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const proof = await encodeCacheProof({ chain: CHAIN, user, publicKey, l1Client: l1, client: l2 });
    console.log(`    proof against L1 block ${proof.l1BlockNumber}, slot ${proof.provenKeySlot}`);
    if (proof.warning) {
      console.log(`    ${proof.warning.split(".")[0]}.`);
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    assert(proof.call.chainId === L2.chainId, "the proof is encoded for the L2");
    assert(proof.call.to === L2.cache, "and addressed to the cache");
    try {
      const hash = await l2Wallet.sendTransaction({
        to: proof.call.to,
        value: proof.call.value,
        data: proof.call.data,
        account: l2Wallet.account!,
        chain: celoSepolia,
      });
      const receipt = await l2.waitForTransactionReceipt({ hash });
      assert(receipt.status === "success", `the proof confirmed (${hash})`);
      console.log(`    relayed: ${L2.explorerUrl}/tx/${hash}`);
      return;
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
      console.log(`    attempt ${attempt} failed: ${message}`);
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 12_000));
    }
  }
}

/** Tops a balance up and waits for it to be visible, not just for the receipt. */
async function fund(
  wallet: ReturnType<typeof createWalletClient>,
  client: PublicClient,
  to: Address,
  amount: bigint,
  where: string,
) {
  const chain = client.chain!;
  const hash = await wallet.sendTransaction({ to, value: amount, account: wallet.account!, chain });
  await client.waitForTransactionReceipt({ hash });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if ((await client.getBalance({ address: to })) >= amount) break;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log(`    funded ${formatEther(amount)} on ${where}`);
}

/** Returns the owner's leftover CELO. Its Sepolia dust stays with the saved key. */
async function sweep(owner: ReturnType<typeof privateKeyToAccount>, _l2Funder: ReturnType<typeof createWalletClient>) {
  console.log("\n[sweep] return leftover CELO to the funder");
  try {
    const wallet = createWalletClient({ account: owner, chain: celoSepolia, transport: http(CELO_RPC) });
    const balance = await l2.getBalance({ address: owner.address });
    const gas = parseEther("0.01");
    if (balance <= gas) {
      console.log(`    ${formatEther(balance)} CELO left, below the transfer cost; kept`);
      return;
    }
    const funder = privateKeyToAccount(process.env.TEST_FUNDER_KEY as Hex);
    const hash = await wallet.sendTransaction({
      to: funder.address,
      value: balance - gas,
      account: owner,
      chain: celoSepolia,
    });
    await l2.waitForTransactionReceipt({ hash });
    console.log(`    returned ${formatEther(balance - gas)} CELO (${hash})`);
  } catch (err) {
    console.log(`    sweep failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
}

function saveKey(comment: string, name: string, key: Hex) {
  appendFileSync(testnetEnvFile(), `\n# ${comment}, ${new Date().toISOString()}\n${name}=${key}\n`);
  console.log("    owner key saved to the shared testnet env file");
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  process.exit(1);
});
