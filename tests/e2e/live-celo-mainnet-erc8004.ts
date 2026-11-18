/**
 * The live registration of the Altana agent's ERC-8004 identity on Celo
 * mainnet: the wallet mints its agent token on Celo's AgentIdentity registry
 * and publishes a record that points at the published agent card.
 *
 *   0. registry  the registry the SDK uses on Celo, and that it is deployed
 *   1. wallet    the Altana wallet of MAINNET_TEST_CELO_KEY
 *   2. quote     what the scoped session costs, before anything is signed
 *   3. grant     (with --send) a one hour session that may only call the
 *                registry's `register` and `setAgentURI`
 *   4. mint      the agent token; the id comes from the relay's receipt
 *   5. publish   the record, with the assigned id written into it
 *   6. read      the wallet owns the token and the record names it and the
 *                published agent card
 *   7. revoke    the session, so the run leaves nothing usable
 *
 * The session is account-only (`register: false`): it is a scoped helper for
 * this one job and is revoked at the end, so it is not written to the KeyStore.
 *
 * WITHOUT `--send` THIS IS A DRY RUN: it reads, quotes and prints, and signs
 * and sends nothing. A send also needs `--i-am-doris` and a phrase typed at an
 * interactive terminal.
 *
 * Keys come from the environment and are never printed:
 *   set -a; source <ecosystem>/.env.mainnet; set +a
 * Optional: CELO_MAINNET_RPC_URL for this script's own reads.
 *
 * Run (from tests/e2e):
 *   bun run live:celo-erc8004
 *   bun run live:celo-erc8004 -- --send --i-am-doris
 *   bun run live-celo-mainnet-erc8004.ts show <agentId>
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
  quoteGrantSession,
  formatQuoteLine,
  CELO,
  type Erc8004RegistrationFile,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { createPublicClient, formatEther, formatUnits, http, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celoMainnetForScript, confirmMainnetSend, transactionLine } from "./mainnet-guard.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const SEND = flag("--send");
const { network, rehearsal: REHEARSAL } = celoMainnetForScript<NetworkConfig>(CELO);
const CHAIN_ID = network.chainId;
const NAME = network.chain.name;
const REGISTRY = erc8004Registry(CHAIN_ID) as Address;
const AGENT_CARD_URL = "https://docs.altana.network/.well-known/agent-card.json";
const HOUR = 3600;

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`CHECK FAILED: ${what}`);
  console.log(`    ok: ${what}`);
}

/** The identity record. `registrations` is empty until the mint assigns an id. */
const registrationFile = (): Erc8004RegistrationFile => ({
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name: "Altana Wallet Agent",
  description:
    "Runs a non-custodial Altana agentic wallet on Celo: fees paid in CELO or a stablecoin the relay accepts, " +
    "and timeboxed session keys recorded in Celo's KeyStore.",
  image: "https://docs.altana.network/altana-icon.png",
  services: [
    { name: "MCP", endpoint: AGENT_CARD_URL },
    { name: "docs", endpoint: "https://docs.altana.network" },
  ],
  registrations: [],
});

async function show(agentId: bigint) {
  const { owner, agentUri } = await getErc8004Agent(network, agentId);
  console.log(`agent ${agentId} on ${NAME}`);
  console.log(`  owner:  ${owner}`);
  console.log(`  record: ${JSON.stringify(decodeErc8004AgentUri(agentUri), null, 2)}`);
}

async function main() {
  const [cmd, arg] = args;
  if (cmd === "show") return show(BigInt(arg!));

  console.log(`@altananetwork/sdk live proof: ERC-8004 agent on ${NAME} (chain ${CHAIN_ID}), ${SEND ? "SENDING" : "dry run"}${REHEARSAL ? " (REHEARSAL on local forks, no real funds)" : ""}`);
  const pub = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });

  console.log("\n[0] the registry");
  const registryCode = await pub.getCode({ address: REGISTRY });
  check(registryCode && registryCode !== "0x", `the AgentIdentity registry is deployed at ${REGISTRY}`);

  console.log("\n[1] the wallet");
  const adminKey = process.env.MAINNET_TEST_CELO_KEY as Hex;
  if (!adminKey) throw new Error("Set MAINNET_TEST_CELO_KEY (set -a; source <ecosystem>/.env.mainnet; set +a).");
  const admin = signerFromPrivateKey(adminKey);
  const wallet = { address: privateKeyToAccount(adminKey).address };
  const code = await pub.getCode({ address: wallet.address });
  check(code && code !== "0x", `${wallet.address} is an Altana wallet set up on ${NAME}`);
  console.log(`    holding ${formatEther(await pub.getBalance({ address: wallet.address }))} CELO`);

  // Two selectors on one address, for an hour. The cap pays the relay's fee for
  // the session's own transactions; the relays quote up to about a CELO each.
  const grant = {
    register: false as const,
    permissions: { calls: erc8004RegisterPermissions(CHAIN_ID), spend: [{ limit: parseEther("3"), period: "day" as const }] },
    expiry: Math.floor(Date.now() / 1000) + HOUR,
  };
  console.log(`\n[2] quote the session scoped to the registry`);
  for (const p of grant.permissions.calls) console.log(`    allowed: ${(p as { signature: string }).signature} @ ${(p as { to: Address }).to}`);
  const quote = await quoteGrantSession(wallet, admin, grant, { networks: [network] });
  for (const line of quote.lines) console.log(`    quote: ${formatQuoteLine(line, network).split("\n")[0]}`);
  for (const b of quote.balances) {
    console.log(`    balance: ${formatUnits(b.balance, b.decimals)} ${b.symbol}, needs ${formatUnits(b.needed, b.decimals)}${b.sufficient ? "" : " (SHORT)"}`);
  }

  if (!SEND) {
    console.log("\nDry run: nothing was signed or sent. A send grants the session, mints the agent, publishes its record and revokes the session.");
    return;
  }
  await confirmMainnetSend({ args, what: `real CELO from ${wallet.address} on ${NAME}`, phrase: "spend real CELO" });

  const client = createClient({ chains: [network] });
  console.log("\n[3] grant the session");
  const session = await client.grantSession({ wallet, signer: admin, ...grant });
  check(session.status === "granted", `the session is granted (${session.legs.find((l) => l.transactionHash)?.transactionHash ?? "no hash"})`);

  let agentId: bigint | undefined;
  try {
    console.log("\n[4] mint the agent");
    const phase1 = registrationFile();
    const minted = await registerErc8004Agent(session, { agentUri: encodeErc8004AgentUri(phase1) }, { network });
    agentId = minted.agentId;
    check(minted.status === "CONFIRMED", `agent ${minted.agentId} minted`);
    console.log(`    ${transactionLine(network.explorer, minted.transactionHash, REHEARSAL)}`);

    console.log("\n[5] publish the record");
    const completed = withErc8004Registration(phase1, minted.agentId, CHAIN_ID);
    const patched = await setErc8004AgentUri(session, { agentId: minted.agentId, agentUri: encodeErc8004AgentUri(completed) }, { network });
    check(patched.status === "CONFIRMED", "the record is published as the agent's URI");
    console.log(`    ${transactionLine(network.explorer, patched.transactionHash, REHEARSAL)}`);

    console.log("\n[6] read it back");
    const onChain = await getErc8004Agent(network, minted.agentId);
    check(onChain.owner.toLowerCase() === wallet.address.toLowerCase(), `the wallet owns agent ${minted.agentId}`);
    const record = decodeErc8004AgentUri(onChain.agentUri);
    check(
      record.registrations[0]?.agentId === Number(minted.agentId) && record.registrations[0]?.agentRegistry === `eip155:${CHAIN_ID}:${REGISTRY}`,
      `the record names agent ${minted.agentId} on this registry`,
    );
    check(record.services.some((s) => s.endpoint === AGENT_CARD_URL), `the record points at the published agent card (${AGENT_CARD_URL})`);
  } finally {
    console.log("\n[7] revoke the session");
    try {
      const revoked = await client.revokeSession({ wallet, signer: admin, session });
      console.log(`    ${revoked.status}  ${transactionLine(network.explorer, revoked.transactionHash, REHEARSAL)}`);
    } catch (e) {
      console.log(`    revoke did not complete: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}. The session expires within the hour.`);
    }
  }

  console.log(`\nResult: PASS. Agent ${agentId} is registered on ${NAME}.`);
  console.log(`    For the agent card's "registrations": ${JSON.stringify({ agentId: Number(agentId), agentRegistry: `eip155:${CHAIN_ID}:${REGISTRY}` })}`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
