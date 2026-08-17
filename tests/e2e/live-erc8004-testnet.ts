/**
 * LIVE (BSC testnet, real relay, real registry) — ERC-8004 agent identity
 * through a SELECTOR-SCOPED session key.
 *
 * What this adds over `fork-erc8004.ts`, which runs on every CI build:
 *
 *   - The RELAY leg. The fork test proves the permission policy against the
 *     account's real bytecode (`canExecute`) and the registry against its real
 *     bytecode, but it never submits an intent. This is the only tier where a
 *     session-signed intent goes through `wallet_prepareCalls` →
 *     `wallet_sendPreparedCalls` → GuardedExecutor for a `signature`-scoped
 *     key. Every other session this repo has ever granted was `{to}`-only.
 *   - The end-to-end negative: a session granted WITHOUT the permissions is
 *     rejected by the live relay + account, not just by `canExecute`.
 *
 * Everything else it checks — the _safeMint into a 7702 account, the two-phase
 * record, the owner gate, the selector scoping — is already covered
 * automatically by the fork tier. Treat this as the release gate, not the
 * feature's only proof.
 *
 * NEEDS A FUNDED WALLET. The BSC-testnet relay does not sponsor: it rejects an
 * unfunded wallet at `wallet_prepareCalls`, and the relay's own faucet
 * (`fundNative`) is currently a no-op — it returns a transaction hash for a
 * transfer to 0x0 and moves nothing. So the admin EOA must be funded manually
 * with tBNB (~0.05 covers gas plus two KeyStore registration fees).
 *
 * The key comes from either source, env first so CI can inject a secret:
 *   ALTANA_TESTNET_ADMIN_KEY=0x…   bun run live-erc8004-testnet.ts
 *   echo '{"adminPrivateKey":"0x…"}' > tests/e2e/.live-erc8004-state.json
 *
 * Run: bun run live-erc8004-testnet.ts [show <agentId>]
 */
import { formatEther, parseEther, type Address, type Hex } from "viem";
import {
  createClient,
  signerFromPrivateKey,
  erc8004RegisterPermissions,
  registerErc8004Agent,
  setErc8004AgentUri,
  getErc8004Agent,
  encodeErc8004AgentUri,
  decodeErc8004AgentUri,
  withErc8004Registration,
  erc8183Addresses,
  waitForBalance,
  BNB_TESTNET,
  type Erc8004RegistrationFile,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";

const STATE_FILE = new URL("./.live-erc8004-state.json", import.meta.url).pathname;
const REGISTRY = erc8183Addresses(97).registry;
const publicClient = buildPublicClient(BNB_TESTNET);
const HOUR = 3600;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const registrationFile = (): Erc8004RegistrationFile => ({
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Altana Live Sentinel",
  description: "Live-testnet agent registered from an Altana wallet by a scoped session key.",
  image: "",
  services: [{ name: "A2A", endpoint: "https://sentinel.example/.well-known/agent-card.json" }],
  registrations: [],
});

/**
 * The admin key, from `ALTANA_TESTNET_ADMIN_KEY` or the untracked state file.
 * Fails loudly and specifically: a silent skip here would let the one tier
 * that covers the relay leg quietly stop running.
 */
async function loadAdminKey(): Promise<{ state: Record<string, unknown>; adminPrivateKey: Hex }> {
  const state = await Bun.file(STATE_FILE)
    .text()
    .then((t) => JSON.parse(t) as Record<string, unknown>)
    .catch(() => ({}) as Record<string, unknown>);

  const fromEnv = process.env.ALTANA_TESTNET_ADMIN_KEY;
  const adminPrivateKey = (fromEnv || (state.adminPrivateKey as string | undefined)) as Hex | undefined;
  if (!adminPrivateKey) {
    throw new Error(
      `No funded admin key. Set ALTANA_TESTNET_ADMIN_KEY, or write {"adminPrivateKey":"0x…"} to\n` +
        `  ${STATE_FILE}\n` +
        `The EOA must hold ~0.05 tBNB: the relay does not sponsor unfunded wallets and its\n` +
        `faucet is a no-op, so this cannot self-fund. Fork coverage runs without it\n` +
        `(bun run fork:erc8004) but does not exercise the relay.`,
    );
  }
  return { state, adminPrivateKey };
}

async function show(agentId: bigint) {
  const { owner, agentUri } = await getErc8004Agent(BNB_TESTNET, agentId);
  console.log(`agent ${agentId}`);
  console.log(`  owner: ${owner}`);
  console.log(`  record: ${JSON.stringify(decodeErc8004AgentUri(agentUri), null, 2)}`);
}

async function main() {
  const [, , cmd, arg] = process.argv;
  if (cmd === "show") return show(BigInt(arg!));

  console.log("LIVE ERC-8004 identity on BSC testnet — real relay, real registry");
  console.log("=================================================================\n");

  const { state, adminPrivateKey } = await loadAdminKey();
  const client = createClient({ chains: [BNB_TESTNET] });
  const admin = signerFromPrivateKey(adminPrivateKey);
  const wallet = await client.createWallet({ signer: admin });
  console.log(`[1] wallet ${wallet.address}`);
  await waitForBalance(publicClient, wallet.address, parseEther("0.005"), 300_000);
  console.log(`    balance: ${formatEther(await publicClient.getBalance({ address: wallet.address }))} tBNB`);

  // ── 2. The bounded capability: a session that may call exactly these two
  // selectors on exactly this address, plus a small native cap for gas. ──
  console.log(`[2] grantSession scoped to ${REGISTRY} by selector ...`);
  const session = await client.grantSession({
    wallet,
    signer: admin,
    permissions: {
      calls: erc8004RegisterPermissions(97),
      spend: [{ limit: parseEther("0.02"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + HOUR,
  });
  console.log(`    session ${session.publicKey.slice(0, 20)}… granted (tx ${session.transactionHash})`);
  for (const p of erc8004RegisterPermissions(97)) {
    console.log(`    allowed: ${(p as { signature: string }).signature} @ ${(p as { to: Address }).to}`);
  }

  // ── 3. Phase 1 — the mint. This is also the 7702 _safeMint moment: the
  // account being minted to is the wallet, which carries delegated code. ──
  console.log("[3] registerErc8004Agent(session, …) — minting into the 7702 account ...");
  const phase1 = registrationFile();
  const minted = await registerErc8004Agent(
    session,
    { agentUri: encodeErc8004AgentUri(phase1) },
    { network: BNB_TESTNET },
  );
  console.log(`    ✓ agent ${minted.agentId} minted — ${minted.status}, tx ${minted.transactionHash}`);

  // ── 4. Phase 2 — patch the assigned id into the record and write it back. ──
  console.log("[4] setErc8004AgentUri(session, …) — publishing the completed record ...");
  const completedUri = encodeErc8004AgentUri(withErc8004Registration(phase1, minted.agentId, 97));
  const patched = await setErc8004AgentUri(
    session,
    { agentId: minted.agentId, agentUri: completedUri },
    { network: BNB_TESTNET },
  );
  assert(patched.status === "CONFIRMED", `setAgentURI confirmed (got ${patched.status})`);
  console.log(`    ✓ ${patched.status}, tx ${patched.transactionHash}`);

  // ── 5. Read it back off chain. ──
  const onChain = await getErc8004Agent(BNB_TESTNET, minted.agentId);
  assert(
    onChain.owner.toLowerCase() === wallet.address.toLowerCase(),
    `the wallet owns agent ${minted.agentId} (ownerOf=${onChain.owner})`,
  );
  const record = decodeErc8004AgentUri(onChain.agentUri);
  assert(
    record.registrations[0]?.agentId === Number(minted.agentId) &&
      record.registrations[0]?.agentRegistry === `eip155:97:${REGISTRY}`,
    `the published record names agent ${minted.agentId} on this registry`,
  );
  console.log(`[5] ✓ read back: owner ${onChain.owner}, record names agent ${minted.agentId}`);

  // ── 6. The negative. A session scoped elsewhere must be rejected at the
  // account's validator — this is what makes the grant a *bounded* capability
  // rather than a formality. ──
  console.log("[6] negative: a session WITHOUT the permissions must fail on register ...");
  const unscoped = await client.grantSession({
    wallet,
    signer: admin,
    permissions: {
      // Deliberately the wrong target: the ERC-8183 kernel, not the registry.
      calls: [{ to: erc8183Addresses(97).commerce }],
      spend: [{ limit: parseEther("0.02"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + HOUR,
  });
  let rejected = false;
  try {
    const bad = await registerErc8004Agent(
      unscoped,
      { agentUri: encodeErc8004AgentUri(registrationFile()) },
      { network: BNB_TESTNET },
    );
    console.log(`    unexpected success: agent ${bad.agentId} (tx ${bad.transactionHash})`);
  } catch (e) {
    rejected = true;
    console.log(`    ✓ rejected: ${(e as Error).message.split("\n")[0]}`);
  }
  assert(rejected, "an out-of-scope session must not be able to register");

  await Bun.write(
    STATE_FILE,
    JSON.stringify(
      {
        ...state,
        walletAddress: wallet.address,
        agentId: minted.agentId.toString(),
        registerTx: minted.transactionHash,
        setAgentUriTx: patched.transactionHash,
        registeredAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\nResult: PASS ✓ — selector-scoped session registered agent ${minted.agentId}.`);
  console.log(`state saved → ${STATE_FILE}`);
  console.log(`inspect: bun run live-erc8004-testnet.ts show ${minted.agentId}`);
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
