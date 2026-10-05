/**
 * Prepare KeyStore keys ahead of time, so a demonstration does not have to
 * wait for Celo's L1 anchor.
 *
 * The Celo KeyStoreCache only accepts a proof built against the exact Ethereum
 * block the L2 anchors at that moment, and that anchor trails Ethereum's head
 * by 70 to 95 blocks, advancing in bursts. So a key registered now is not
 * provable for roughly half an hour, and a proof stops reading valid once the
 * anchor moves past the block it was built against. Preparing keys in advance
 * moves all of that waiting off the critical path.
 *
 * It prepares three kinds:
 *
 *   A  registered and anchored, deliberately NOT proven, so the proof can be
 *      sent on demand in one step.
 *   B  the valid-then-revoked pair: registered, proven, revoked on the
 *      registry chain, and the revocation proven. Final state: revoked.
 *   C  a passkey wallet with a registered session key. A passkey admin cannot
 *      sign an Ethereum transaction, so its registry write goes through the
 *      registry chain's relay; the leg's `via` is asserted to prove it.
 *
 * Registration is paid in the registry chain's native token by the wallet
 * itself: when its balance covers the registration fee plus the gas allowance,
 * no cross-chain funding is requested.
 *
 * Resumable. The output file IS the state: every stage reads it, does only
 * what is missing, and writes it back, so a crash costs no anchor wait.
 *
 *   bun run prepare-showcase-keys.ts              # every stage in order
 *   bun run prepare-showcase-keys.ts --stage=register
 *   bun run prepare-showcase-keys.ts --stage=prove
 *   bun run prepare-showcase-keys.ts --stage=revoke
 *   bun run prepare-showcase-keys.ts --stage=prove-revoked
 *   bun run prepare-showcase-keys.ts --report      # read chain, print state
 *
 * Needs TEST_FUNDER_KEY with native funds on both chains:
 *   set -a; source <path>/.env.testnet; set +a
 * Output path: KEYS_OUT, default ./showcase-keys.json
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createClient,
  createHeadlessPasskey,
  signerFromPrivateKey,
  CELO_SEPOLIA,
  SEPOLIA,
  keyStoreCacheOf,
  readCachedKey,
  isCachedKeyValid,
  readL1Anchor,
  type Session,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Find the shared .env.testnet by walking up. A worktree sits two directories
 * deeper than a main checkout, so a fixed "../../../.env.testnet" lands beside
 * the worktrees folder and creates keys in a file nobody reads. Never create
 * one: if it is missing, that is a setup error, not something to paper over.
 */
function sharedEnvPath(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    const p = join(dir, ".env.testnet");
    if (existsSync(p)) return p;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error(
    ".env.testnet not found walking up from " + import.meta.dir +
      ". It lives in the ecosystem root and is never created by a script.",
  );
}

const ENV_PATH = sharedEnvPath();
const FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex | undefined;
if (!FUNDER_KEY) {
  throw new Error(
    "Set TEST_FUNDER_KEY (Sepolia ETH + Celo Sepolia CELO): " +
      `set -a; source ${ENV_PATH}; set +a`,
  );
}
const funder = privateKeyToAccount(FUNDER_KEY);

const CELO_RPC = process.env.CELO_SEPOLIA_RPC_URL || CELO_SEPOLIA.publicRpcUrl;
const SEP_RPC = process.env.SEPOLIA_RPC_URL || SEPOLIA.publicRpcUrl;
const CACHE = keyStoreCacheOf(CELO_SEPOLIA)!;

const celoPublic = createPublicClient({ chain: CELO_SEPOLIA.chain, transport: http(CELO_RPC) });
const sepPublic = createPublicClient({ chain: SEPOLIA.chain, transport: http(SEP_RPC) });
const client = createClient({ chains: [CELO_SEPOLIA, SEPOLIA], defaultChainId: CELO_SEPOLIA.chainId });

/**
 * A passkey wallet has to be provisioned from a CELO-ONLY client.
 *
 * createWallet({ signer: headlessPasskey }) bootstraps through a throwaway
 * EOA per chain, so across a two-chain client it produces two different
 * addresses and refuses: "Multichain createWallet needs a signer with a
 * deterministic address". createPasskeyWallet is the deterministic path but
 * it needs WebAuthn, which there is no OS keychain for in Node.
 *
 * Provisioning on Celo alone is enough: grantSession still writes to the
 * Sepolia KeyStore, because the registry chain comes from CELO_SEPOLIA's own
 * registry config and the relay carries the Sepolia leg (and the 7702
 * authorization with it). smoke-celo-passkey.ts relies on exactly this.
 */
const celoOnlyClient = createClient({ chains: [CELO_SEPOLIA], defaultChainId: CELO_SEPOLIA.chainId });

// .env.testnet sits in the ecosystem root, so the harness is its sibling.
const OUT_PATH =
  process.env.KEYS_OUT ?? new URL("./showcase-keys.json", import.meta.url).pathname;

const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;
const log = (s: string) => console.log(`${s}  [${ms()}]`);

const KEYSTORE_ABI = [
  { name: "isValidKey", type: "function", stateMutability: "view",
    inputs: [{ name: "user", type: "address" }, { name: "keyId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }] },
] as const;

/** The account's wrapped hash, which is NOT the KeyStore's keccak256(publicKey). */
const accountKeyHash = (keyType: number, publicKey: Hex): Hex =>
  keccak256(encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes32" }],
    [keyType, keccak256(publicKey)],
  ));

// ---------------------------------------------------------------------------
// The file is the state
// ---------------------------------------------------------------------------

type KeyRecord = {
  label: string;
  role: "A-valid" | "A-spare-1" | "A-spare-2" | "A-spare-3" | "A-spare-4" | "B-revoked" | "C-passkey";
  demoNote: string;
  user: Address;
  walletKind: "secp256k1" | "passkey";
  keyType: number;
  keyTypeName: string;
  isSuperAdmin: boolean;
  expiry: number;
  publicKey: Hex;
  keyStoreKeyId: Hex;
  accountKeyHash: Hex;
  registrationTx?: Hex;
  registrationL1Block?: number;
  registrationVia?: string;
  cacheProofTx?: Hex | null;
  anchoredL1Block?: number | null;
  revocationTx?: Hex | null;
  revocationL1Block?: number | null;
  revocationCacheProofTx?: Hex | null;
  revocationAnchoredL1Block?: number | null;
  verified?: Record<string, unknown>;
};

type State = {
  $comment: string;
  updated: string;
  contracts: unknown;
  derivation: unknown;
  howToUse: unknown;
  keys: KeyRecord[];
};

function load(): State {
  if (existsSync(OUT_PATH)) {
    const s = JSON.parse(readFileSync(OUT_PATH, "utf8")) as Partial<State>;
    if (Array.isArray(s.keys)) return s as State;
  }
  return { $comment: "", updated: "", contracts: {}, derivation: {}, howToUse: {}, keys: [] };
}

function save(s: State) {
  s.updated = new Date().toISOString().slice(0, 10);
  s.$comment =
    "KeyStore keys prepared ahead of time by tests/e2e/prepare-showcase-keys.ts. " +
    "Every field was read from chain. The demo LOADS this file; it never retypes a hash. " +
    "publicKey is the field the mirror card needs: populateKey takes the public key and the " +
    "cache checks it hashes to keyId, so keyId alone cannot prove anything.";
  s.contracts = {
    keyStore: { chainId: SEPOLIA.chainId, address: SEPOLIA.keyStore },
    keyStoreCache: { chainId: CELO_SEPOLIA.chainId, address: CACHE, version: "1.1.1" },
  };
  s.derivation = {
    keyStoreKeyId: "keccak256(publicKey)",
    accountKeyHash: "keccak256(abi.encode(uint8 keyType, keccak256(publicKey)))",
    note:
      "These are DIFFERENT values. The KeyStore, the cache and populateKey all use keyStoreKeyId. " +
      "The account's getKeys() returns accountKeyHash. Querying either contract with the other's " +
      "hash returns an empty entry, not an error, so a key that is plainly there reads as absent.",
  };
  s.howToUse = {
    mirrorCard: "Pass user + publicKey. Read with isValidKey(user, keyStoreKeyId).",
    timing:
      "The mirror answers for ONE anchored L1 block, not 'now'. isValidKey requires " +
      "sourceBlockNumber == IL1Block.number() exactly. A key proven earlier reads valid only " +
      "while Celo still anchors that block (about 20 minutes), so the demo re-proves on demand " +
      "rather than relying on a proof made hours ago.",
    roles: {
      "A-valid": "Registered and anchored, never proven. Prove it live in one step.",
      "B-revoked": "Registered, proven valid, revoked on Sepolia, revocation proven. Final: revoked.",
      "C-passkey": "Passkey wallet, session key registered through the Sepolia relay, proven in.",
    },
  };
  writeFileSync(OUT_PATH, JSON.stringify(s, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Funding
// ---------------------------------------------------------------------------

/**
 * The relay's own fee on Sepolia dominates: a measured quote wanted 0.004894
 * ETH, of which 0.004521 was the relay fee and only 0.000373 the two
 * registration fees. The SDK's REGISTRY_FEE_ALLOWANCE_WEI is 0.001, so a
 * wallet holding between value+0.001 and value+relayFee is judged able to
 * self-pay, skips L2 funding, and is then rejected by the relay with
 * "quote has asset deficits". Fund well clear of that band.
 */
const SEPOLIA_FUND = parseEther("0.012");
const CELO_FUND = parseEther("0.5");

async function waitForBalance(read: () => Promise<bigint>, want: bigint, what: string) {
  // A confirmed transfer receipt does NOT mean the next call can be quoted:
  // the public RPC serves a stale balance for a while and the relay then
  // reports asset deficits on a wallet that is funded.
  for (let i = 0; i < 40; i++) {
    if ((await read()) >= want) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${what}: balance never reached ${want}`);
}

/** Wait for a receipt, but never fail on the wait itself: the caller checks the balance. */
async function settle(c: typeof sepPublic | typeof celoPublic, hash: Hex, what: string) {
  try {
    await c.waitForTransactionReceipt({ hash, timeout: 180_000 });
  } catch {
    log(`    ${what}: receipt wait timed out for ${hash}; polling the balance instead`);
  }
}

async function fund(address: Address) {
  const sepWallet = createWalletClient({ account: funder, chain: SEPOLIA.chain, transport: http(SEP_RPC) });
  const celoWallet = createWalletClient({ account: funder, chain: CELO_SEPOLIA.chain, transport: http(CELO_RPC) });

  const haveSep = await sepPublic.getBalance({ address });
  if (haveSep < SEPOLIA_FUND) {
    const h = await sepWallet.sendTransaction({ to: address, value: SEPOLIA_FUND - haveSep });
    // The public Sepolia RPC regularly takes longer than viem's default to
    // serve a receipt. A timeout here means "I stopped watching", NOT "the
    // transfer failed" -- one did land in block 11840819 after throwing. The
    // balance is the fact that matters, so poll it and let the receipt go.
    await settle(sepPublic, h, "Sepolia funding");
    await waitForBalance(() => sepPublic.getBalance({ address }), SEPOLIA_FUND, "Sepolia ETH");
    log(`    funded ${formatEther(SEPOLIA_FUND - haveSep)} ETH on Sepolia`);
  }
  const haveCelo = await celoPublic.getBalance({ address });
  if (haveCelo < CELO_FUND) {
    const h = await celoWallet.sendTransaction({ to: address, value: CELO_FUND - haveCelo });
    await settle(celoPublic, h, "CELO funding");
    await waitForBalance(() => celoPublic.getBalance({ address }), CELO_FUND, "CELO");
    log(`    funded ${formatEther(CELO_FUND - haveCelo)} CELO`);
  }
}

/** Persist a throwaway key BEFORE it is funded, so funds can never be stranded. */
function persistKey(name: string, address: Address, key: Hex) {
  const cur = readFileSync(ENV_PATH, "utf8");
  if (cur.includes(`SHOWCASE_${name}_ADDRESS=${address}`)) return;
  appendFileSync(
    ENV_PATH,
    `\n# prepared wallet ${name}, ${new Date().toISOString().slice(0, 10)}\n` +
      `SHOWCASE_${name}_ADDRESS=${address}\nSHOWCASE_${name}_KEY=${key}\n`,
  );
  log(`    key persisted to the shared .env.testnet as SHOWCASE_${name}_KEY`);
}

// ---------------------------------------------------------------------------
// Stage 1: register
// ---------------------------------------------------------------------------

const GRANT_DAYS = 30;

async function registerOne(
  role: KeyRecord["role"],
  label: string,
  demoNote: string,
  kind: "secp256k1" | "passkey",
): Promise<KeyRecord> {
  log(`\n[register] ${role}: ${label}`);

  let wallet: { address: Address };
  let signer: any;
  if (kind === "passkey") {
    const passkey = createHeadlessPasskey();
    const w = await celoOnlyClient.createWallet({ signer: passkey });
    wallet = { address: w.address };
    signer = passkey;
    log(`    passkey wallet ${wallet.address}`);
    // A headless passkey's credential lives only in this process. The demo
    // never signs with it -- it only reads the mirror -- so nothing is lost.
  } else {
    // Reuse the key persisted for this role. Generating a fresh one on every
    // attempt orphans the previous wallet WITH ITS FUNDING, and because the
    // env var name is the same, the new entry shadows the old one when the
    // file is sourced, so the orphan becomes unreachable as well as unfunded.
    const envName = `SHOWCASE_${role.replace(/-/g, "_").toUpperCase()}_KEY`;
    const existing = process.env[envName] as Hex | undefined;
    const key = existing ?? generatePrivateKey();
    const s = signerFromPrivateKey(key);
    if (existing) log(`    reusing the wallet already persisted as ${envName}`);
    else persistKey(role.replace(/-/g, "_").toUpperCase(), s.address, key);
    const w = await client.createWallet({ signer: s });
    wallet = { address: w.address };
    signer = s;
    log(`    wallet ${wallet.address}`);
  }

  await fund(wallet.address);

  const sepBefore = await sepPublic.getBalance({ address: wallet.address });
  log(`    Sepolia ETH before the write: ${formatEther(sepBefore)} (pays the registration itself)`);

  const granted = await (kind === "passkey" ? celoOnlyClient : client).grantSession({
    wallet,
    signer,
    permissions: { calls: [{ to: funder.address }], spend: [{ limit: parseEther("0.1"), period: "day" }] },
    expiry: Math.floor(Date.now() / 1000) + GRANT_DAYS * 24 * 3600,
    register: true,
    populateCache: false, // the proof is a separate, timed stage
    chainIds: [CELO_SEPOLIA.chainId],
    onStatus: (s: string, d: any) => log(`    ${s}${d?.chainId ? ` (chain ${d.chainId})` : ""}`),
  });

  for (const l of granted.legs) {
    log(`    leg ${l.kind}@${l.chainId}: ${l.status}${l.via ? ` via ${l.via}` : ""}${l.reason ? ` (${l.reason})` : ""}`);
  }
  if (granted.status !== "granted") throw new Error(`grant ${granted.status}`);

  const reg = granted.legs.find((l) => l.kind === "registry" && l.chainId === SEPOLIA.chainId);
  if (!reg || reg.status !== "CONFIRMED") throw new Error(`registry leg ${reg?.status}: ${reg?.reason}`);
  if (reg.fundedFromChainId !== undefined) {
    throw new Error(
      `the write was funded from chain ${reg.fundedFromChainId}. It was supposed to be paid in ` +
        `the registry chain's own native token by the wallet, which is what this script asserts.`,
    );
  }
  if (kind === "passkey" && reg.via !== "relay") {
    throw new Error(`a passkey wallet's registry write must go via the relay, got via=${reg.via}`);
  }
  log(`    registry write ${reg.transactionHash} at Sepolia block ${reg.blockNumber}, via ${reg.via}`);

  // Poll. The registry write's receipt is confirmed before the public Sepolia
  // RPC will answer isValidKey with it, so a single read here fails a
  // registration that has demonstrably landed (0xd89d61f5..., status 1).
  // Same trap as the revocation read below, and as the funding reads above.
  let valid = false;
  for (let i = 0; i < 40 && !valid; i++) {
    valid = (await sepPublic.readContract({
      address: SEPOLIA.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey",
      args: [wallet.address, granted.keyId],
    })) as boolean;
    if (!valid) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!valid) throw new Error("the key is not valid on the Sepolia KeyStore, after 2 minutes of polling");
  log(`    Sepolia KeyStore.isValidKey = true`);

  const sepAfter = await sepPublic.getBalance({ address: wallet.address });
  log(`    Sepolia ETH after: ${formatEther(sepAfter)} (spent ${formatEther(sepBefore - sepAfter)})`);

  // The later stages sign the proof and the revocation with this admin, so
  // keep the live objects. They are in memory only: a stage run in a separate
  // process cannot sign, and says so rather than failing obscurely.
  sessions.set(role, { session: granted, wallet, signer, client: kind === "passkey" ? celoOnlyClient : client });

  const keyType = 2; // the SESSION key is secp256k1 even under a passkey admin
  return {
    label, role, demoNote,
    user: wallet.address,
    walletKind: kind,
    keyType,
    keyTypeName: "Secp256k1",
    isSuperAdmin: false,
    expiry: granted.expiry,
    publicKey: granted.publicKey,
    keyStoreKeyId: granted.keyId,
    accountKeyHash: accountKeyHash(keyType, granted.publicKey),
    registrationTx: reg.transactionHash!,
    registrationL1Block: Number(reg.blockNumber),
    registrationVia: reg.via,
    cacheProofTx: null,
    anchoredL1Block: null,
    revocationTx: null,
    revocationL1Block: null,
    revocationCacheProofTx: null,
    revocationAnchoredL1Block: null,
    verified: { keyStoreIsValidKey: true, paidInSepoliaEth: true },
  };
}

/** The live session objects, kept in memory across stages within one run. */
const sessions = new Map<string, { session: Session; wallet: { address: Address }; signer: any; client: typeof client }>();

async function stageRegister(s: State) {
  const want: Array<[KeyRecord["role"], string, string, "secp256k1" | "passkey"]> = [
    ["A-valid", "showcase A: valid, prove on demand",
      "Registered and anchored well before the demo, deliberately NOT proven. The mirror card proves it live in one step, with no anchor wait.",
      "secp256k1"],
    ["B-revoked", "showcase B: valid, then revoked",
      "The pair. Proven valid into the mirror, then revoked on Sepolia and the revocation proven. Final state: the mirror says revoked, and that is the honest end state.",
      "secp256k1"],
    ["C-passkey", "showcase C: passkey wallet, registered session key",
      "A passkey admin cannot sign an Ethereum transaction, so the registry write goes through the Sepolia relay. Proven into the mirror.",
      "passkey"],
    // Spares in A's role. Proving a key SPENDS it: the cache then holds it and
    // the "never proven" state cannot be shown again. A lost anchor race on
    // stage therefore has no retry unless an identical unproven key is ready.
    ["A-spare-1", "showcase A spare 1: valid, prove on demand",
      "Identical to A and equally unproven. Use it if A's proof loses the anchor race, because proving a key spends it and A has no second chance.",
      "secp256k1"],
    ["A-spare-2", "showcase A spare 2: valid, prove on demand",
      "The second spare. Same role as A, held back for the same reason.",
      "secp256k1"],
    ["A-spare-3", "showcase A spare 3: for measuring the anchor race",
      "Made to be spent: fired at a proof deliberately just before an anchor jump, to measure how the 60-second re-prove reads on screen.",
      "secp256k1"],
    ["A-spare-4", "showcase A spare 4: valid, prove on demand",
      "Held back as the second showcase spare, alongside A-spare-2.",
      "secp256k1"],
  ];
  for (const [role, label, note, kind] of want) {
    if (s.keys.some((k) => k.role === role && k.registrationTx)) { log(`[register] ${role} already done, skipping`); continue; }
    const rec = await registerOne(role, label, note, kind);
    s.keys = [...s.keys.filter((k) => k.role !== role), rec];
    save(s);
    log(`    recorded ${role}`);
  }
}

// ---------------------------------------------------------------------------
// Stage 2 and 4: prove into the mirror
// ---------------------------------------------------------------------------

/**
 * Rebuild what the later stages need, without the live Session object.
 *
 * syncSessionToCache and revokeSession both accept a bare PUBLIC KEY in place
 * of a Session, so neither needs the session's own signer -- only the admin
 * and the key's bytes. The admin key is persisted, and the public key is in
 * this file, so a secp256k1 role resumes in a fresh process.
 *
 * A passkey admin cannot: a headless passkey's credential lives only in the
 * process that made it. So C has to be registered and proven in one run, and
 * this says so plainly instead of failing at the relay.
 */
function adminFor(rec: KeyRecord): { wallet: { address: Address }; signer: any; client: typeof client } {
  const live = sessions.get(rec.role);
  if (live) return { wallet: live.wallet, signer: live.signer, client: live.client };
  if (rec.walletKind === "passkey") {
    throw new Error(
      `${rec.role}: a headless passkey's credential exists only in the process that created it, ` +
        `so this role cannot be resumed. Re-run with --stage=all to register and prove it in one go.`,
    );
  }
  const envName = `SHOWCASE_${rec.role.replace(/-/g, "_").toUpperCase()}_KEY`;
  const key = process.env[envName] as Hex | undefined;
  if (!key) throw new Error(`${rec.role}: ${envName} is not in the environment; source .env.testnet`);
  const signer = signerFromPrivateKey(key);
  if (signer.address.toLowerCase() !== rec.user.toLowerCase()) {
    throw new Error(`${envName} is wallet ${signer.address}, but this record is for ${rec.user}`);
  }
  return { wallet: { address: rec.user }, signer, client };
}

async function proveKey(rec: KeyRecord, afterBlock: number, which: "registration" | "revocation") {
  const live = adminFor(rec);
  const anchor = await readL1Anchor(celoPublic);
  const head = await sepPublic.getBlockNumber();
  log(`    Sepolia head ${head}, Celo anchors ${anchor.number} (${head - anchor.number} behind), target ${afterBlock}`);
  log(`    waiting for the anchor to pass ${afterBlock}; this is the ~20 minute wait the demo must not do`);

  const proof = await live.client.syncSessionToCache({
    wallet: live.wallet,
    signer: live.signer,
    session: rec.publicKey, // a bare public key is accepted, so no session signer is needed
    afterL1Block: BigInt(afterBlock),
    anchorTimeoutMs: 45 * 60 * 1000,
    onStatus: (st: string, d: any) => log(`    ${st}${d?.l1BlockNumber ? ` @L1 ${d.l1BlockNumber}` : ""} (attempt ${d?.attempt})`),
  });
  if (proof.status !== "CONFIRMED") throw new Error(`cache proof ${proof.status}`);
  log(`    proof ${proof.transactionHash} against L1 block ${proof.l1BlockNumber} (${proof.attempts} attempt(s))`);

  const cached = await readCachedKey(celoPublic, CACHE, rec.user, rec.keyStoreKeyId);
  const valid = await isCachedKeyValid(celoPublic, CACHE, rec.user, rec.keyStoreKeyId);
  log(`    mirror: revoked=${cached.revoked}  isCachedKeyValid=${valid}  sourceBlock=${cached.sourceBlockNumber}`);

  if (which === "registration") {
    if (cached.revoked) throw new Error("the mirror reports revoked before any revocation");
    if (cached.publicKey.toLowerCase() !== rec.publicKey.toLowerCase()) {
      throw new Error("the mirror does not hold this key's public key");
    }
    rec.cacheProofTx = proof.transactionHash!;
    rec.anchoredL1Block = Number(proof.l1BlockNumber);
    rec.verified = { ...rec.verified, mirrorValidAtProof: valid, keccakCachedPublicKeyMatchesKeyId: keccak256(cached.publicKey) === rec.keyStoreKeyId };
  } else {
    if (!cached.revoked) throw new Error("the mirror does not report the key as revoked after the revocation proof");
    rec.revocationCacheProofTx = proof.transactionHash!;
    rec.revocationAnchoredL1Block = Number(proof.l1BlockNumber);
    rec.verified = { ...rec.verified, mirrorRevoked: true, isCachedKeyValidAfterRevocation: valid };
  }
}

async function stageProve(s: State) {
  for (const role of ["B-revoked", "C-passkey"] as const) {
    const rec = s.keys.find((k) => k.role === role);
    if (!rec) { log(`[prove] ${role} not registered yet`); continue; }
    if (rec.cacheProofTx) { log(`[prove] ${role} already proven, skipping`); continue; }
    log(`\n[prove] ${role}`);
    await proveKey(rec, rec.registrationL1Block!, "registration");
    save(s);
  }
  for (const r of ["A-valid", "A-spare-1", "A-spare-2", "A-spare-3", "A-spare-4"]) {
    if (s.keys.find((k) => k.role === r)) {
      log(`\n[prove] ${r} left unproven on purpose: proving it would spend it`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 3: revoke B on Sepolia
// ---------------------------------------------------------------------------

async function stageRevoke(s: State) {
  const rec = s.keys.find((k) => k.role === "B-revoked");
  if (!rec) { log("[revoke] B not registered yet"); return; }
  if (rec.revocationTx) { log("[revoke] B already revoked, skipping"); return; }
  if (!rec.cacheProofTx) { log("[revoke] B must be proven valid first, so the pair has a 'before'"); return; }
  const live = adminFor(rec);

  log("\n[revoke] B on the Sepolia KeyStore");
  // revokeSession has no populateCache switch: it writes the revocation and
  // then proves it into the mirror itself, waiting for the anchor to reach the
  // revocation block. So this call carries the ~20 minute wait, and
  // stage prove-revoked only has to run when its cache leg did not confirm.
  const res = await live.client.revokeSession({
    wallet: live.wallet, signer: live.signer, session: rec.publicKey,
    onStatus: (st: string, d: any) => log(`    ${st}${d?.chainId ? ` (chain ${d.chainId})` : ""}`),
  });
  for (const l of res.legs) log(`    leg ${l.kind}@${l.chainId}: ${l.status}${l.reason ? ` (${l.reason})` : ""}`);
  if (res.status !== "revoked") throw new Error(`revokeSession ${res.status}`);

  const reg = res.legs.find((l) => l.kind === "registry" && l.chainId === SEPOLIA.chainId);
  if (!reg || reg.status !== "CONFIRMED") throw new Error(`revocation registry leg ${reg?.status}`);
  rec.revocationTx = reg.transactionHash!;
  rec.revocationL1Block = Number(reg.blockNumber);
  log(`    revoked at Sepolia block ${reg.blockNumber}, tx ${reg.transactionHash}`);

  // Poll, do not read once. A confirmed revocation receipt does not mean the
  // next read reflects it: the public Sepolia RPC lags its own receipts, and a
  // single read here reported the key still valid for a revocation that had
  // demonstrably landed (0xfcb40975..., block 11847934, status 1).
  let valid = true;
  for (let i = 0; i < 40 && valid; i++) {
    valid = (await sepPublic.readContract({
      address: SEPOLIA.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey",
      args: [rec.user, rec.keyStoreKeyId],
    })) as boolean;
    if (valid) await new Promise((r) => setTimeout(r, 3000));
  }
  if (valid) throw new Error("the KeyStore still reports the key valid after revocation, after 2 minutes of polling");
  log(`    Sepolia KeyStore.isValidKey = false`);
  rec.verified = { ...rec.verified, keyStoreValidAfterRevocation: false };

  // Its own cache leg may already have proven the revocation.
  const cacheLeg = res.legs.find((l) => l.kind === "cache" && l.chainId === CELO_SEPOLIA.chainId);
  if (cacheLeg?.status === "CONFIRMED" && cacheLeg.transactionHash) {
    const cached = await readCachedKey(celoPublic, CACHE, rec.user, rec.keyStoreKeyId);
    if (!cached.revoked) throw new Error("the revoke cache leg confirmed but the mirror does not say revoked");
    rec.revocationCacheProofTx = cacheLeg.transactionHash;
    rec.revocationAnchoredL1Block = Number(cacheLeg.l1BlockNumber ?? 0) || null;
    rec.verified = { ...rec.verified, mirrorRevoked: true };
    log(`    revocation already proven by the revoke's own cache leg: ${cacheLeg.transactionHash}`);
  } else {
    log(`    revoke cache leg ${cacheLeg?.status ?? "absent"}${cacheLeg?.reason ? ` (${cacheLeg.reason})` : ""}; stage prove-revoked will do it`);
  }
  save(s);
}

async function stageProveRevoked(s: State) {
  const rec = s.keys.find((k) => k.role === "B-revoked");
  if (!rec?.revocationTx) { log("[prove-revoked] B not revoked yet"); return; }
  if (rec.revocationCacheProofTx) { log("[prove-revoked] already proven, skipping"); return; }
  log("\n[prove-revoked] B: prove the revocation into the mirror");
  await proveKey(rec, rec.revocationL1Block!, "revocation");
  save(s);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

async function report(s: State) {
  const anchor = await readL1Anchor(celoPublic);
  const head = await sepPublic.getBlockNumber();
  console.log(`\nSepolia head ${head}; Celo anchors ${anchor.number} (${head - anchor.number} blocks behind)\n`);
  for (const k of s.keys) {
    const ks = await sepPublic.readContract({
      address: SEPOLIA.keyStore, abi: KEYSTORE_ABI, functionName: "isValidKey",
      args: [k.user, k.keyStoreKeyId],
    });
    const cached = await readCachedKey(celoPublic, CACHE, k.user, k.keyStoreKeyId);
    const fresh = await isCachedKeyValid(celoPublic, CACHE, k.user, k.keyStoreKeyId);
    const proven = cached.sourceBlockNumber > 0n;
    console.log(`${k.role}  ${k.user}`);
    console.log(`  KeyStore.isValidKey      ${ks}`);
    console.log(`  mirror entry             ${proven ? `present (sourceBlock ${cached.sourceBlockNumber}, revoked=${cached.revoked})` : "never proven"}`);
    console.log(`  mirror isCachedKeyValid  ${fresh}${proven && !fresh && !cached.revoked ? "  <- stale: anchor moved past the proof, re-prove to read valid" : ""}`);
    console.log(`  anchored at proof time   ${k.anchoredL1Block ?? "-"}   provable now: ${anchor.number >= BigInt(k.registrationL1Block ?? 0)}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------

const arg = process.argv.find((a) => a.startsWith("--stage="));
const stage = arg ? arg.split("=")[1] : "all";
const s = load();

if (process.argv.includes("--report")) {
  await report(s);
} else {
  log(`funder ${funder.address}`);
  log(`Sepolia ETH ${formatEther(await sepPublic.getBalance({ address: funder.address }))}, CELO ${formatEther(await celoPublic.getBalance({ address: funder.address }))}`);
  log(`writing ${OUT_PATH}`);

  if (stage === "all" || stage === "register") await stageRegister(s);
  if (stage === "all" || stage === "prove") await stageProve(s);
  if (stage === "all" || stage === "revoke") await stageRevoke(s);
  if (stage === "all" || stage === "prove-revoked") await stageProveRevoked(s);
  save(s);
  await report(s);
  log("done");
}
