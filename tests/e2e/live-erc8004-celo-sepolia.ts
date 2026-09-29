/**
 * LIVE (Celo Sepolia, real relay, real registry) — the Altana agent's ERC-8004
 * identity, minted by a selector-scoped session key.
 *
 * Celo has the ERC-8004 `AgentIdentity` registry (`0x8004A818…` on Celo
 * Sepolia) and none of the ERC-8183 job-escrow stack, so identity is the whole
 * story here: mint the token, publish the record, read it back, and prove the
 * session key could do nothing else on the registry.
 *
 * The record's `services` entry points at the published agent card,
 * `https://docs.altana.network/.well-known/agent-card.json`, which is
 * `docs/public/.well-known/agent-card.json` in this repo.
 *
 * Steps:
 *   1. a throwaway wallet, funded in CELO from the shared testnet funder
 *   2. an account-only session (`register: false`) scoped to the registry's
 *      `register` and `setAgentURI` selectors, with a CELO spend cap. The
 *      account enforces the scope, which is what step 6 proves; the Ethereum
 *      KeyStore leg is proven by the spine and the passkey smoke test, so this
 *      script stays on Celo.
 *   3. phase 1: mint, recovering the agentId from the relay's receipt
 *   4. phase 2: patch the id into the record and publish it as the tokenURI
 *   5. read it back: the wallet owns the token and the record names it
 *   6. the negative: a session scoped elsewhere cannot register
 *   7. sweep the wallet back to the funder
 *
 * Needs, and fails loudly without:
 *   TEST_FUNDER_KEY       funded with CELO on Celo Sepolia (>= 1 CELO)
 *   CELO_SEPOLIA_RPC_URL  optional override of the Celo Sepolia read RPC
 *
 * Run: bun run live:erc8004-celo   (from tests/e2e)
 *      bun run live-erc8004-celo-sepolia.ts show <agentId>
 */
import {
  createClient,
  signerFromPrivateKey,
  erc8004Registry,
  erc8004RegisterPermissions,
  registerErc8004Agent,
  setErc8004AgentUri,
  getErc8004Agent,
  encodeErc8004AgentUri,
  decodeErc8004AgentUri,
  withErc8004Registration,
  quoteCalls,
  quoteGrantSession,
  formatQuoteLine,
  CELO_SEPOLIA,
  type Erc8004RegistrationFile,
  type NetworkConfig,
} from "@altananetwork/sdk";
import {
  createClient as createViemClient,
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";

const CHAIN_ID = CELO_SEPOLIA.chainId;
const REGISTRY = erc8004Registry(CHAIN_ID);
const HOUR = 3600;
const STATE_FILE = new URL("./.live-erc8004-celo-state.json", import.meta.url).pathname;
const AGENT_CARD_URL = "https://docs.altana.network/.well-known/agent-card.json";
/** CELO for the mint, the record write, two grants and the sweep. */
const FUNDING = parseEther("0.5");

const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};
const publicClient = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function showJson(v: unknown) {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

/**
 * The identity record. `registrations` is empty until the mint assigns an id;
 * phase 2 fills it in. Everything else is what the published agent card says.
 */
const registrationFile = (): Erc8004RegistrationFile => ({
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Altana Wallet Agent",
  description:
    "Runs a non-custodial Altana agentic wallet on Celo: gas paid in any fee token the relay accepts, " +
    "timeboxed session keys recorded in the Ethereum KeyStore and mirrored into the Celo KeyStoreCache.",
  image: "https://docs.altana.network/altana-icon.png",
  services: [
    { name: "MCP", endpoint: AGENT_CARD_URL },
    { name: "docs", endpoint: "https://docs.altana.network" },
  ],
  registrations: [],
});

async function show(agentId: bigint) {
  const { owner, agentUri } = await getErc8004Agent(network, agentId);
  console.log(`agent ${agentId} on ${network.chain.name}`);
  console.log(`  owner:  ${owner}`);
  console.log(`  record: ${JSON.stringify(decodeErc8004AgentUri(agentUri), null, 2)}`);
}

async function main() {
  const [, , cmd, arg] = process.argv;
  if (cmd === "show") return show(BigInt(arg!));

  console.log("LIVE ERC-8004 identity on Celo Sepolia — real relay, real registry");
  console.log("=================================================================\n");

  const funderKey = process.env.TEST_FUNDER_KEY as Hex;
  if (!funderKey) {
    throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  }
  const funder = privateKeyToAccount(funderKey);
  const funderWallet = createWalletClient({ account: funder, chain: network.chain, transport: http(network.publicRpcUrl) });
  const funderBalance = await publicClient.getBalance({ address: funder.address });
  console.log(`funder ${funder.address}: ${formatEther(funderBalance)} CELO`);
  if (funderBalance < parseEther("1")) {
    throw new Error(`Fund ${funder.address} with at least 1 CELO on Celo Sepolia: https://faucet.celo.org/celo-sepolia`);
  }
  console.log(`registry ${REGISTRY}`);

  // ── 1. A throwaway wallet. Its key is saved before any funds move. ──
  const adminKey = generatePrivateKey();
  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [network] });
  const wallet = await client.createWallet({ signer: admin });
  saveThrowawayKey(wallet.address, adminKey);
  console.log(`\n[1] wallet ${wallet.address}`);
  const fundTx = await funderWallet.sendTransaction({ to: wallet.address, value: FUNDING });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log(`    funded ${formatEther(FUNDING)} CELO`);

  try {
    await run(client, admin, wallet);
  } finally {
    await sweepBack(admin, wallet, funder.address);
  }
}

async function run(
  client: ReturnType<typeof createClient>,
  admin: ReturnType<typeof signerFromPrivateKey>,
  wallet: { address: Address },
) {
  // ── 2. The bounded capability: two selectors on one address, nothing else.
  // `register: false` keeps this on Celo. The account enforces the selector
  // scope and the expiry itself, which is the boundary step 6 tests; the
  // Ethereum KeyStore entry is the third-party-verifiable record of the same
  // grant and is proven by the spine and the passkey smoke test, so requiring
  // it here would only couple an identity test to Sepolia's gas price and to
  // whether the relay's interop path is live. ──
  console.log(`\n[2] grantSession scoped to ${REGISTRY} by selector`);
  const grant = {
    register: false as const,
    permissions: {
      calls: erc8004RegisterPermissions(CHAIN_ID),
      spend: [{ limit: parseEther("0.3"), period: "day" as const }],
    },
    expiry: Math.floor(Date.now() / 1000) + HOUR,
  };
  // Price it before signing anything: the relay's own numbers, so a rejection
  // for "asset deficits" can be read against the wallet's balance.
  const quote = await quoteGrantSession(wallet, admin, grant, { networks: [network] });
  for (const line of quote.lines) console.log(`    quote: ${formatQuoteLine(line, network)}`);
  for (const b of quote.balances) {
    console.log(
      `    balance: ${formatEther(b.balance)} ${b.symbol} on chain ${b.chainId}, needs ` +
        `${formatEther(b.needed)}${b.sufficient ? "" : " (SHORT)"}`,
    );
  }
  const session = await client.grantSession({
    wallet,
    signer: admin,
    register: false,
    permissions: {
      calls: erc8004RegisterPermissions(CHAIN_ID),
      spend: [{ limit: parseEther("0.3"), period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + HOUR,
  });
  if (session.status !== "granted") {
    throw new Error(`grantSession failed: ${showJson(session.legs)}`);
  }
  for (const p of erc8004RegisterPermissions(CHAIN_ID)) {
    console.log(`    allowed: ${(p as { signature: string }).signature} @ ${(p as { to: Address }).to}`);
  }

  // ── 3. Phase 1: the mint. The registry uses _safeMint, and the recipient is
  // a 7702 account carrying delegated code, which is the interesting part. ──
  console.log("\n[3] registerErc8004Agent(session, …)");
  const phase1 = registrationFile();
  const minted = await registerErc8004Agent(session, { agentUri: encodeErc8004AgentUri(phase1) }, { network });
  console.log(`    agent ${minted.agentId} minted — ${minted.status}, tx ${minted.transactionHash}`);

  // ── 4. Phase 2: patch the assigned id in and publish the record. ──
  console.log("\n[4] setErc8004AgentUri(session, …)");
  const completed = withErc8004Registration(phase1, minted.agentId, CHAIN_ID);
  const patched = await setErc8004AgentUri(
    session,
    { agentId: minted.agentId, agentUri: encodeErc8004AgentUri(completed) },
    { network },
  );
  assert(patched.status === "CONFIRMED", `setAgentURI confirmed (got ${patched.status})`);
  console.log(`    ${patched.status}, tx ${patched.transactionHash}`);

  // ── 5. Read it back off chain. ──
  const onChain = await getErc8004Agent(network, minted.agentId);
  assert(
    onChain.owner.toLowerCase() === wallet.address.toLowerCase(),
    `the wallet owns agent ${minted.agentId} (ownerOf=${onChain.owner})`,
  );
  const record = decodeErc8004AgentUri(onChain.agentUri);
  assert(
    record.registrations[0]?.agentId === Number(minted.agentId) &&
      record.registrations[0]?.agentRegistry === `eip155:${CHAIN_ID}:${REGISTRY}`,
    `the published record names agent ${minted.agentId} on this registry`,
  );
  assert(
    record.services.some((s) => s.endpoint === AGENT_CARD_URL),
    `the record points at the published agent card (${AGENT_CARD_URL})`,
  );
  console.log(`\n[5] read back: owner ${onChain.owner}, record names agent ${minted.agentId}`);
  console.log(`    ${JSON.stringify(record)}`);

  // ── 6. The negative: the session is a bounded capability, not a formality. ──
  console.log("\n[6] negative: a session scoped elsewhere must not be able to register");
  const unscoped = await client.grantSession({
    wallet,
    signer: admin,
    register: false,
    // Deliberately the wrong target: the wallet itself, not the registry.
    permissions: { calls: [{ to: wallet.address }], spend: [{ limit: parseEther("0.1"), period: "day" }] },
    expiry: Math.floor(Date.now() / 1000) + HOUR,
  });
  if (unscoped.status !== "granted") {
    throw new Error(`grantSession failed: ${showJson(unscoped.legs)}`);
  }
  let rejected = false;
  try {
    const bad = await registerErc8004Agent(unscoped, { agentUri: encodeErc8004AgentUri(registrationFile()) }, { network });
    console.log(`    unexpected success: agent ${bad.agentId} (tx ${bad.transactionHash})`);
  } catch (e) {
    rejected = true;
    console.log(`    rejected: ${(e as Error).message.split("\n")[0]}`);
  }
  assert(rejected, "an out-of-scope session must not be able to register");

  await Bun.write(
    STATE_FILE,
    JSON.stringify(
      {
        chainId: CHAIN_ID,
        registry: REGISTRY,
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
  console.log(`\nResult: PASS — a selector-scoped session registered agent ${minted.agentId} on Celo Sepolia.`);
  console.log(`state saved to ${STATE_FILE}`);
  console.log(`inspect: bun run live-erc8004-celo-sepolia.ts show ${minted.agentId}`);
}

/** The throwaway admin key, so nothing is stranded if the run dies. */
function saveThrowawayKey(address: Address, key: Hex) {
  const file = process.env.TESTNET_ENV_FILE ?? new URL("../../../.env.testnet", import.meta.url).pathname;
  appendFileSync(
    file,
    `\n# live-erc8004-celo-sepolia throwaway wallet ${address}, ${new Date().toISOString()}: admin key\n` +
      `ERC8004_CELO_${address.slice(2, 10).toUpperCase()}_KEY=${key}\n`,
  );
  console.log("    throwaway key saved to the shared testnet env file");
}

/** Returns what is left to the funder, sized from the relay's own quote. Never throws. */
async function sweepBack(admin: ReturnType<typeof signerFromPrivateKey>, wallet: { address: Address }, funder: Address) {
  console.log("\n[sweep] return leftover CELO to the funder");
  try {
    const balance = await publicClient.getBalance({ address: wallet.address });
    if (balance === 0n) {
      console.log("    nothing left");
      return;
    }
    const relay = createViemClient({ chain: network.chain, transport: http(network.relayUrl!) });
    const probe = await quoteCalls(relay, wallet.address, admin, [{ to: funder, value: 1n, data: "0x" }], {
      feeToken: "0x0000000000000000000000000000000000000000",
      submittingKey: { type: "secp256k1", publicKey: admin.publicKey, role: "admin" },
      network,
    });
    const fee = probe.nativeNeeded - 1n;
    const amount = balance - (fee * 13n) / 10n;
    if (amount <= 0n) {
      console.log(`    ${formatEther(balance)} CELO left, below the transfer fee (${formatEther(fee)}); kept`);
      return;
    }
    const res = await createClient({ chains: [network] }).execute({
      wallet,
      signer: admin,
      calls: { to: funder, value: amount, data: "0x" },
    });
    console.log(`    returned ${formatEther(amount)} CELO (${res.status}${res.transactionHash ? ` ${res.transactionHash}` : ""})`);
  } catch (err) {
    console.log(`    sweep failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e);
  process.exit(1);
});
