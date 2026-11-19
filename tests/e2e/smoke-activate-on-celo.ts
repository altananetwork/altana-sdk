/**
 * A wallet made on BNB testnet is used on Celo Sepolia for the first time.
 *
 * This is what a wallet app does when its user picks another network: the
 * wallet was created with a client that knew BNB testnet only, it has
 * transacted there, and now the same wallet sends its first transaction on
 * Celo Sepolia. Nothing is provisioned again in between.
 *
 * Run once for a passkey wallet and once for a private-key wallet:
 *   1. create the wallet with createClient({ chains: [BNB_TESTNET] })
 *   2. fund it with tBNB and send one transaction on BNB testnet; the key is
 *      registered in BNB testnet's KeyStore
 *   3. fund the same address with CELO on Celo Sepolia
 *   4. with createClient({ chains: [BNB_TESTNET, CELO_SEPOLIA] }) and the same
 *      signer, send one transaction on Celo Sepolia
 *   5. the address is the same, it carries code on Celo Sepolia, and its key
 *      is registered in Celo Sepolia's KeyStore
 *   6. sweep: what is left on both chains goes back to the funder, pass or
 *      fail. The wallet's credential or key is appended to the shared testnet
 *      env file before any funds move.
 *
 * Needs TEST_FUNDER_KEY, funded with tBNB on BNB testnet and CELO on Celo
 * Sepolia. ACTIVATE_ONLY=passkey|key runs one of the two.
 *
 * Run: bun run smoke:activate-on-celo   (from tests/e2e)
 */

import {
  createClient,
  createHeadlessPasskey,
  quoteCalls,
  signerFromPrivateKey,
  waitForBalance,
  BNB_TESTNET,
  CELO_SEPOLIA,
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
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { appendFileSync } from "node:fs";
import { readActiveKeys, readRegistrationFee, registrationValueFor } from "../../packages/wallet/src/internal/keystore.js";
import { testnetEnvFile } from "./testnet-env.js";

const TEST_FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex;
if (!TEST_FUNDER_KEY) throw new Error("Set TEST_FUNDER_KEY: funded with tBNB on BNB testnet and CELO on Celo Sepolia.");

const bnbTestnet: NetworkConfig = {
  ...BNB_TESTNET,
  ...(process.env.BSC_TESTNET_RPC_URL ? { publicRpcUrl: process.env.BSC_TESTNET_RPC_URL } : {}),
};
const celoSepolia: NetworkConfig = {
  ...CELO_SEPOLIA,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
};

const BNB_HEADROOM = parseEther(process.env.ACTIVATE_BNB_HEADROOM ?? "0.008");
const CELO_HEADROOM = parseEther(process.env.ACTIVATE_CELO_HEADROOM ?? "2.6");

type AnySigner = Parameters<ReturnType<typeof createClient>["execute"]>[0] extends { signer?: infer S } ? S : never;

function check(cond: unknown, what: string): void {
  if (!cond) throw new Error(`FAILED: ${what}`);
  console.log(`    ok: ${what}`);
}
/** A read right after a write, repeated until a load-balanced RPC shows it. */
async function settles(read: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await read().catch(() => false)) return check(true, what);
    await new Promise((r) => setTimeout(r, 1_500));
  }
  check(false, what);
}
function publicFor(network: NetworkConfig): PublicClient {
  return createPublicClient({ chain: network.chain, transport: http(network.publicRpcUrl) }) as PublicClient;
}

const funder = privateKeyToAccount(TEST_FUNDER_KEY);

async function fund(network: NetworkConfig, to: Address, headroom: bigint): Promise<void> {
  const pub = publicFor(network);
  const symbol = network.chain.nativeCurrency.symbol;
  const amount = registrationValueFor(await readRegistrationFee(pub, network)) + headroom;
  const have = await pub.getBalance({ address: funder.address });
  if (have < amount + parseEther("0.002")) {
    throw new Error(`The funder ${funder.address} holds ${formatEther(have)} ${symbol} on ${network.chain.name}; this run sends ${formatEther(amount)}.`);
  }
  const wc = createWalletClient({ account: funder, chain: network.chain, transport: http(network.publicRpcUrl) });
  const hash = await wc.sendTransaction({ to, value: amount });
  await pub.waitForTransactionReceipt({ hash });
  await waitForBalance(pub, to, amount, 120_000);
  console.log(`    funded with ${formatEther(amount)} ${symbol} on ${network.chain.name}`);
}

async function runOne(kind: "passkey" | "key"): Promise<{ address: Address; bnbTx?: string; celoTx?: string }> {
  console.log(`\n=== ${kind === "passkey" ? "Passkey wallet" : "Private-key wallet"} ===`);
  const bnbPublic = publicFor(bnbTestnet);
  const celoPublic = publicFor(celoSepolia);

  let signer: AnySigner;
  let secretLine: (address: Address) => string;
  if (kind === "passkey") {
    const passkey = createHeadlessPasskey();
    signer = passkey as AnySigner;
    secretLine = (a) => `SMOKE_PASSKEY_${a.slice(2, 10).toUpperCase()}_CREDENTIAL='${JSON.stringify(passkey.credential)}'`;
  } else {
    const pk = generatePrivateKey();
    signer = signerFromPrivateKey(pk) as AnySigner;
    secretLine = (a) => `SMOKE_KEY_${a.slice(2, 10).toUpperCase()}=${pk}`;
  }

  console.log("[1] create the wallet on BNB testnet only");
  const bnbOnly = createClient({ chains: [bnbTestnet] });
  const wallet = await bnbOnly.createWallet({ signer: signer as never });
  console.log("    wallet:", wallet.address);
  appendFileSync(
    testnetEnvFile(),
    `\n# smoke-activate-on-celo ${kind} wallet ${wallet.address}, ${new Date().toISOString()}\n${secretLine(wallet.address)}\n`,
  );
  console.log("    its credential is saved to the shared testnet env file");

  const out: { address: Address; bnbTx?: string; celoTx?: string } = { address: wallet.address };
  try {
    console.log("[2] first transaction on BNB testnet");
    await fund(bnbTestnet, wallet.address, BNB_HEADROOM);
    const onBnb = await bnbOnly.execute({ wallet, signer: signer as never, calls: { to: funder.address, value: 1n, data: "0x" } });
    console.log("    status:", onBnb.status, onBnb.transactionHash ?? "");
    if (onBnb.status !== "CONFIRMED") throw new Error("the BNB testnet transaction did not confirm");
    out.bnbTx = onBnb.transactionHash;
    await settles(async () => (await readActiveKeys(bnbPublic, bnbTestnet, wallet.address)).length === 1, "the key is registered in BNB testnet's KeyStore");

    console.log("[3] before Celo Sepolia");
    check(((await celoPublic.getCode({ address: wallet.address })) ?? "0x") === "0x", "the address has no code on Celo Sepolia yet");
    check((await readActiveKeys(celoPublic, celoSepolia, wallet.address)).length === 0, "Celo Sepolia's KeyStore holds no key for it yet");
    await fund(celoSepolia, wallet.address, CELO_HEADROOM);

    console.log("[4] first transaction on Celo Sepolia, same wallet, nothing provisioned again");
    const both = createClient({ chains: [bnbTestnet, celoSepolia] });
    const onCelo = await both.execute({
      wallet,
      signer: signer as never,
      chainId: celoSepolia.chainId,
      calls: { to: funder.address, value: 1n, data: "0x" },
    });
    console.log("    status:", onCelo.status, onCelo.transactionHash ?? "");
    if ("agentIdentity" in onCelo) console.log("    agent identity:", JSON.stringify(onCelo.agentIdentity));
    if (onCelo.status !== "CONFIRMED") throw new Error("the Celo Sepolia transaction did not confirm");
    out.celoTx = onCelo.transactionHash;

    console.log("[5] after");
    await settles(async () => ((await celoPublic.getCode({ address: wallet.address })) ?? "0x") !== "0x", "the same address carries the account on Celo Sepolia");
    await settles(async () => (await readActiveKeys(celoPublic, celoSepolia, wallet.address)).length >= 1, "its key is registered in Celo Sepolia's KeyStore");
  } finally {
    console.log("[6] return leftover funds to the funder");
    await sweepBack(celoSepolia, signer, wallet, kind);
    await sweepBack(bnbTestnet, signer, wallet, kind);
  }
  return out;
}

/** Sends what is left on one chain back to the funder. Best effort, never throws. */
async function sweepBack(network: NetworkConfig, signer: AnySigner, wallet: { address: Address }, kind: "passkey" | "key") {
  const symbol = network.chain.nativeCurrency.symbol;
  try {
    const pub = publicFor(network);
    const balance = await pub.getBalance({ address: wallet.address });
    if (balance === 0n) return console.log(`    ${network.chain.name}: nothing left`);
    const relay = createViemClient({ chain: network.chain, transport: http(network.relayUrl!) });
    const probe = await quoteCalls(relay, wallet.address, signer as never, [{ to: funder.address, value: 1n, data: "0x" }], {
      feeToken: "0x0000000000000000000000000000000000000000",
      submittingKey:
        kind === "passkey"
          ? { type: "webauthn-p256", signer: signer as never, role: "admin" }
          : { type: "secp256k1", publicKey: (signer as { publicKey: Hex }).publicKey, role: "admin" },
      network,
    } as never);
    const fee = probe.nativeNeeded - 1n;
    const amount = balance - (fee * 13n) / 10n;
    if (amount <= 0n) return console.log(`    ${network.chain.name}: ${formatEther(balance)} ${symbol} left, below the transfer fee; kept`);
    const res = await createClient({ chains: [network], agentIdentity: false } as never).execute({
      wallet: wallet as never,
      signer: signer as never,
      calls: { to: funder.address, value: amount, data: "0x" },
    });
    console.log(`    ${network.chain.name}: returned ${formatEther(amount)} ${symbol} (${res.status} ${res.transactionHash ?? ""})`);
  } catch (err) {
    console.log(`    ${network.chain.name}: sweep failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
  }
}

async function main() {
  console.log("A wallet made on BNB testnet, first used on Celo Sepolia");
  const only = process.env.ACTIVATE_ONLY;
  const kinds = (["passkey", "key"] as const).filter((k) => !only || only === k);
  const results: Record<string, unknown> = {};
  let failed = false;
  for (const kind of kinds) {
    try {
      results[kind] = { result: "PASS", ...(await runOne(kind)) };
    } catch (err) {
      failed = true;
      results[kind] = { result: "FAIL", reason: (err instanceof Error ? err.message : String(err)).split("\n").slice(0, 3).join(" | ") };
      console.error(`\n${kind} run failed:`, err);
    }
  }
  console.log("\n=== Summary ===");
  console.log(JSON.stringify(results, null, 2));
  if (failed) process.exit(1);
}

main();
