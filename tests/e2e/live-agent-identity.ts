/**
 * LIVE proof: a new wallet gets its agent identity by itself.
 *
 * A wallet's first admin action sets it up in the KeyStore. After that action
 * has confirmed, the SDK registers the wallet in the chain's ERC-8004 registry
 * in a transaction of its own. This script does a first action with a wallet
 * that is new on the chain and reads the result back from the chain:
 *
 *   1. the wallet's key is in the KeyStore,
 *   2. the agent exists, the wallet owns it, and its record says "Altana
 *      Agent" with the Altana icon and a link to the wallet on the explorer,
 *   3. the registration carries the `createdWith = altana` tag,
 *   4. the two are different transactions, and the set-up transaction did not
 *      touch the agent registry.
 *
 * Testnets (`bnb-testnet`, `celo-sepolia`): a throwaway wallet is created,
 * funded from the shared test funder, and what is left is sent back. Its key
 * is saved to the shared testnet env file first, so nothing is stranded.
 *
 * Mainnets (`bnb`, `celo`): the wallet is the one whose key is in
 * AGENT_IDENTITY_WALLET_KEY (or MAINNET_TEST_CELO_KEY). Without `--send` the
 * script only reads and quotes. With `--send --i-am-doris` it asks for a typed
 * phrase and then spends real funds.
 *
 * Run (from tests/e2e):
 *   bun run live:agent-identity -- bnb-testnet
 *   bun run live:agent-identity -- celo-sepolia
 *   bun run live:agent-identity -- bnb                        # reads and quotes
 *   bun run live:agent-identity -- bnb --send --i-am-doris    # spends real BNB
 */
import { appendFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  hexToString,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ALTANA_AGENT_TAG,
  BNB,
  BNB_TESTNET,
  CELO,
  CELO_SEPOLIA,
  ERC8004_ADDRESSES,
  NATIVE_TOKEN,
  agentPageUrl,
  altanaExplorerWalletUrl,
  createClient,
  decodeErc8004AgentUri,
  signerFromPrivateKey,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { confirmMainnetSend } from "./mainnet-guard.js";
import { testnetEnvFile } from "./testnet-env.js";

type Target = { network: NetworkConfig; mainnet: boolean; explorer: string };
const TARGETS: Record<string, Target> = {
  "bnb-testnet": { network: BNB_TESTNET, mainnet: false, explorer: "https://testnet.bscscan.com" },
  "celo-sepolia": { network: CELO_SEPOLIA, mainnet: false, explorer: "https://sepolia.celoscan.io" },
  bnb: { network: BNB, mainnet: true, explorer: "https://bscscan.com" },
  celo: { network: CELO, mainnet: true, explorer: "https://celoscan.io" },
};

const REGISTRY_ABI = [
  { name: "ownerOf", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { name: "tokenURI", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "getMetadata", type: "function", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "string" }], outputs: [{ type: "bytes" }] },
] as const;
const CONTROLLER_ABI = [
  { name: "getRegistrationFeeInWei", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const KEYSTORE_ABI = [
  { name: "getKeys", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bytes32[]" }] },
] as const;

const args = process.argv.slice(2);
const chainArg = args.find((a) => !a.startsWith("--"));
const target = chainArg ? TARGETS[chainArg] : undefined;
if (!target) {
  console.error(`Name a chain: ${Object.keys(TARGETS).join(", ")}.`);
  process.exit(2);
}
const { network, mainnet, explorer } = target;
const symbol = network.chain.nativeCurrency.symbol;
const registry = ERC8004_ADDRESSES[network.chainId]!;
const publicClient = createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) });
const client = createClient({ chains: [network] });

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`    ${ok ? "ok" : "FAIL"}: ${what}`);
  if (!ok) failures += 1;
}

/** A public RPC can answer from a block behind the receipt it just gave. Read until it has caught up. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 20 && !done(value); i++) {
    await new Promise((r) => setTimeout(r, 1500));
    value = await read();
  }
  return value;
}

const keysOf = (wallet: Address) =>
  publicClient.readContract({ address: network.keyStore, abi: KEYSTORE_ABI, functionName: "getKeys", args: [wallet] });
const agentsOf = (wallet: Address) =>
  publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "balanceOf", args: [wallet] });

async function main() {
  console.log(`@altananetwork/sdk live proof: automatic agent identity on ${network.chain.name} (chain ${network.chainId})${mainnet ? (args.includes("--send") ? ", SENDING" : ", reading and quoting only") : ""}`);

  console.log("\n[0] the registry");
  const code = await publicClient.getCode({ address: registry });
  check(!!code && code !== "0x", `the ERC-8004 registry is deployed at ${registry}`);

  const admin = mainnet ? mainnetSigner() : signerFromPrivateKey(generatePrivateKey());
  const wallet = await client.createWallet({ signer: admin });
  const address = wallet.address as Address;

  console.log("\n[1] the wallet");
  const before = await keysOf(address);
  console.log(`    ${address}, ${before.length} key(s) in the KeyStore, ${formatEther(await publicClient.getBalance({ address }))} ${symbol}`);
  if (before.length > 0) {
    console.log(`\nThis wallet is already set up on ${network.chain.name}, so its first action is behind it and the automatic step has nothing to do.`);
    console.log(`It owns ${await agentsOf(address)} agent(s) here. Use a wallet that is new on this chain.`);
    return;
  }
  check((await agentsOf(address)) === 0n, "it owns no agent yet");

  if (!mainnet) {
    saveThrowawayKey(address, (admin as unknown as { _privateKey: Hex })._privateKey);
    // Enough for the registration itself, so the relay will quote the rest.
    const registration = await publicClient.readContract({ address: network.keyStoreController, abi: CONTROLLER_ABI, functionName: "getRegistrationFeeInWei" });
    await fundFromFunder(address, (registration * 12n) / 10n);
  }

  console.log("\n[2] what the first action costs");
  const call = { to: address, value: 0n, data: "0x" as Hex };
  const quote = await client.quoteExecute({ wallet, signer: admin, calls: call, feeToken: NATIVE_TOKEN }).catch((e: Error) => e);
  if (quote instanceof Error) {
    console.log(`    ${quote.message.split("\n")[0]}`);
  } else {
    console.log(`    the wallet's set-up needs ${formatEther(quote.nativeNeeded)} ${symbol}: registration ${formatEther(quote.value)} plus the relay's fee`);
    console.log(`    the agent registration that follows is one more small transaction, paid the same way`);
  }

  if (!mainnet) {
    if (quote instanceof Error) throw quote;
    // The set-up as quoted, then room for two more relayed transactions (the
    // agent registration and the transfer back), each sized by this quote's fee.
    const fee = quote.nativeNeeded - quote.value;
    const held = await publicClient.getBalance({ address });
    await fundFromFunder(address, quote.nativeNeeded + fee * 3n - held);
  } else {
    console.log(`    the wallet holds ${formatEther(await publicClient.getBalance({ address }))} ${symbol}`);
  }
  if (mainnet && !args.includes("--send")) {
    console.log(`\nNothing was sent. To run it for real: bun run live:agent-identity -- ${chainArg} --send --i-am-doris`);
    return;
  }
  if (mainnet) {
    await confirmMainnetSend({ args, what: `real ${symbol} from ${address} on ${network.chain.name}`, phrase: `spend real ${symbol}` });
  }

  console.log("\n[3] the wallet's first action");
  const result = await client.execute({ wallet, signer: admin, calls: call });
  check(result.status === "CONFIRMED", `it confirmed: ${explorer}/tx/${result.transactionHash}`);
  const keys = await eventually(() => keysOf(address), (k) => k.length > 0);
  check(keys.length > 0, "the wallet's key is in the KeyStore");

  console.log("\n[4] the agent identity that followed");
  const identity = result.agentIdentity;
  check(identity?.status === "registered", identity?.status === "registered" ? `agent ${identity.agentId} was registered: ${explorer}/tx/${identity.transactionHash}` : `not registered: ${JSON.stringify(identity)}`);
  if (identity?.status === "registered") {
    const agentId = BigInt(identity.agentId);
    check(identity.transactionHash !== result.transactionHash, "it is a different transaction from the wallet's set-up");
    const setUp = await publicClient.getTransactionReceipt({ hash: result.transactionHash! });
    check(!setUp.logs.some((l) => l.address.toLowerCase() === registry.toLowerCase()), "the set-up transaction did not touch the agent registry");

    const owner = await eventually(
      () => publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "ownerOf", args: [agentId] }).catch(() => "0x" as Address),
      (o) => o.toLowerCase() === address.toLowerCase(),
    );
    check(owner.toLowerCase() === address.toLowerCase(), "the wallet owns the agent");
    const record = decodeErc8004AgentUri(await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "tokenURI", args: [agentId] }));
    check(record.name === "Altana Agent", `its name is "${record.name}"`);
    check(record.image === "https://docs.altana.network/altana-icon.png", "its image is the Altana icon");
    check(record.services[0]?.endpoint === altanaExplorerWalletUrl(network, address), `it links to ${record.services[0]?.endpoint}`);
    const tag = await publicClient.readContract({ address: registry, abi: REGISTRY_ABI, functionName: "getMetadata", args: [agentId, ALTANA_AGENT_TAG.metadataKey] });
    check(tag === ALTANA_AGENT_TAG.metadataValue, `its tag is createdWith = ${hexToString(tag)}`);
    console.log(`    page: ${agentPageUrl(network.chainId, agentId)}`);
  }

  if (!mainnet) await sweepBack(admin, wallet, address);

  console.log(failures === 0 ? `\nResult: PASS. A new wallet on ${network.chain.name} was set up and got its agent identity.` : `\nResult: FAIL (${failures}).`);
  if (failures > 0) process.exit(1);
}

function mainnetSigner() {
  const key = (process.env.AGENT_IDENTITY_WALLET_KEY ?? process.env.MAINNET_TEST_CELO_KEY) as Hex | undefined;
  if (!key) throw new Error("Set AGENT_IDENTITY_WALLET_KEY (or source the mainnet env file, which has MAINNET_TEST_CELO_KEY).");
  return signerFromPrivateKey(key);
}

/** The throwaway key, so nothing is stranded if the run dies. Never printed. */
function saveThrowawayKey(address: Address, key: Hex) {
  appendFileSync(
    testnetEnvFile(),
    `\n# live-agent-identity throwaway wallet ${address} on ${network.chain.name}, ${new Date().toISOString()}: admin key\n` +
      `AGENTIDENTITY_${address.slice(2, 10).toUpperCase()}_KEY=${key}\n`,
  );
  console.log("    throwaway key saved to the shared testnet env file");
}

async function fundFromFunder(to: Address, amount: bigint) {
  const funderKey = process.env.TEST_FUNDER_KEY as Hex | undefined;
  if (!funderKey) throw new Error("Set TEST_FUNDER_KEY: source the shared .env.testnet first.");
  const funder = privateKeyToAccount(funderKey);
  const funderBalance = await publicClient.getBalance({ address: funder.address });
  if (funderBalance < amount * 2n) throw new Error(`The test funder holds ${formatEther(funderBalance)} ${symbol} on ${network.chain.name}: too low to fund ${formatEther(amount)}.`);
  const walletClient = createWalletClient({ account: funder, chain: network.chain, transport: http(network.publicRpcUrl) });
  const held = await publicClient.getBalance({ address: to });
  const hash = await walletClient.sendTransaction({ to, value: amount });
  await publicClient.waitForTransactionReceipt({ hash });
  await eventually(() => publicClient.getBalance({ address: to }), (b) => b >= held + amount);
  console.log(`    funded with ${formatEther(amount)} ${symbol} from the test funder`);
}

/** Returns what is left to the funder, sized from the relay's own quote. Never throws. */
async function sweepBack(admin: ReturnType<typeof signerFromPrivateKey>, wallet: { address: Address }, address: Address) {
  console.log("\n[5] return what is left to the test funder");
  try {
    const funder = privateKeyToAccount(process.env.TEST_FUNDER_KEY as Hex).address;
    const balance = await publicClient.getBalance({ address });
    const probe = await client.quoteExecute({ wallet, signer: admin, calls: { to: funder, value: 1n, data: "0x" }, feeToken: NATIVE_TOKEN });
    const fee = probe.nativeNeeded - 1n;
    const amount = balance - (fee * 13n) / 10n;
    if (amount <= 0n) {
      console.log(`    ${formatEther(balance)} ${symbol} left, below the transfer fee; kept`);
      return;
    }
    const res = await client.execute({ wallet, signer: admin, calls: { to: funder, value: amount, data: "0x" } });
    console.log(`    returned ${formatEther(amount)} ${symbol} (${res.status}): ${explorer}/tx/${res.transactionHash}`);
  } catch (err) {
    console.log(`    not returned: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL");
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
