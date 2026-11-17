/**
 * FORK E2E: Celo keeps its own KeyStore, and the SDK's config points at it.
 *
 * Runs against an anvil fork of Celo Sepolia (default) or Celo mainnet, using
 * the KeyStore and controller at the addresses in the SDK's own config. A wrong
 * address in the config, or a redeploy the config did not follow, fails here
 * rather than in a user's first grant.
 *
 *   1. The config's KeyStore and controller have code on the chain, report the
 *      released versions, and the KeyStore accepts the controller as a writer.
 *   2. A fresh wallet's first action registers its main key: the calls come
 *      from the SDK's own builder (`buildFirstActionPrepend`), carry the fee
 *      plus the SDK's margin, and land in the KeyStore.
 *   3. A session key is registered with the SDK's `registerKey` builder, and
 *      the treasury received exactly two fees: the margin came back.
 *   4. A second "first action" is empty: an already registered wallet is not
 *      registered twice.
 *   5. The session key is revoked with the SDK's `revokeKey` builder and reads
 *      as no longer valid; the main key still does.
 *   6. On the SDK side: the network is its own registry, has no cache, and
 *      registry calls are allowed on it (they are refused on a network that
 *      keeps its registry elsewhere).
 *
 * The calls are sent as plain transactions from the wallet's own key on the
 * fork. The relay path is covered by the live tests; this one pins the
 * contracts, the addresses and the SDK's call encoding to each other.
 *
 * Env:
 *   CELO_SEPOLIA_FORK_RPC_URL  Celo Sepolia RPC to fork (default: public forno).
 *   CELO_FORK_RPC_URL          Celo mainnet RPC to fork (default: public forno).
 *
 * Run: bun run fork:celo-keystore            (Celo Sepolia)
 *      bun run fork:celo-keystore celo       (Celo mainnet)
 */
import { createPublicClient, createTestClient, createWalletClient, http, parseEther, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  BASE_SEPOLIA,
  CELO,
  CELO_SEPOLIA,
  isCachedRegistry,
  keyStoreCacheOf,
  registryNetwork,
  type NetworkConfig,
} from "@altananetwork/sdk";
import {
  buildAdditionalRegisterCall,
  buildFirstActionPrepend,
  buildRevokeKeyCall,
  deriveKeyId,
  readActiveKeys,
  readIsValidKey,
  readRegistrationFee,
  registrationValueFor,
} from "../../packages/wallet/src/internal/keystore.js";
import { assertNoRegistryTargets, needsFirstActionPrepend } from "../../packages/wallet/src/internal/relay.js";
import { startAnvil, waitForAnvil } from "./anvil.js";

const which = (process.argv[2] ?? "celo-sepolia").toLowerCase();
const TARGETS: Record<string, { network: NetworkConfig; forkUrl: string; port: number }> = {
  // `||`, not `??`: an unset GitHub Actions secret arrives as an empty string.
  "celo-sepolia": { network: CELO_SEPOLIA, forkUrl: process.env.CELO_SEPOLIA_FORK_RPC_URL || CELO_SEPOLIA.publicRpcUrl, port: 8561 },
  celo: { network: CELO, forkUrl: process.env.CELO_FORK_RPC_URL || "https://forno.celo.org", port: 8562 },
};
const target = TARGETS[which];
if (!target) throw new Error(`unknown network "${which}": use celo-sepolia or celo`);
const { network } = target;

const VERSION_ABI = [{ name: "VERSION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;
const KEYSTORE_ADMIN_ABI = [
  { name: "authorizedContracts", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;
const CONTROLLER_ABI = [
  { name: "keyStore", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "treasury", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

let failed = 0;
const log = (m: string) => console.log(m);
function assert(cond: unknown, what: string): void {
  if (cond) log(`  ok    ${what}`);
  else {
    failed++;
    log(`  FAIL  ${what}`);
  }
}

async function main() {
  log(`FORK E2E: ${network.chain.name} keeps its own KeyStore (${network.keyStore})`);
  const anvil = startAnvil(target!.forkUrl, target!.port, ["--silent", "--optimism"]);
  const transport = http(anvil.url);
  const pub = createPublicClient({ chain: network.chain, transport });
  const test = createTestClient({ chain: network.chain, mode: "anvil", transport });
  try {
    await waitForAnvil(anvil, () => pub.getBlockNumber());
    assert((await pub.getChainId()) === network.chainId, `the fork is ${network.chain.name} (${network.chainId})`);

    log("\n▶ the config's contracts are the ones on the chain");
    const [ksCode, ctCode] = await Promise.all([pub.getCode({ address: network.keyStore }), pub.getCode({ address: network.keyStoreController })]);
    if (!ksCode || !ctCode) {
      assert(false, `code at the config's KeyStore (${network.keyStore}) and controller (${network.keyStoreController}): nothing is deployed there on this chain`);
      return;
    }
    assert(true, "code at the config's KeyStore and controller");
    assert((await pub.readContract({ address: network.keyStore, abi: VERSION_ABI, functionName: "VERSION" })) === "1.0.1", "KeyStore VERSION is 1.0.1");
    assert((await pub.readContract({ address: network.keyStoreController, abi: VERSION_ABI, functionName: "VERSION" })) === "1.1.1", "KeyStoreController VERSION is 1.1.1");
    const controllerKeyStore = await pub.readContract({ address: network.keyStoreController, abi: CONTROLLER_ABI, functionName: "keyStore" });
    assert(controllerKeyStore.toLowerCase() === network.keyStore.toLowerCase(), "the controller writes to the config's KeyStore");
    assert(await pub.readContract({ address: network.keyStore, abi: KEYSTORE_ADMIN_ABI, functionName: "authorizedContracts", args: [network.keyStoreController] }), "the KeyStore accepts the controller as a writer");
    const treasury = await pub.readContract({ address: network.keyStoreController, abi: CONTROLLER_ABI, functionName: "treasury" });
    const fee = await readRegistrationFee(pub, network);
    assert(fee > 0n, `the registration fee reads above zero (${fee} wei)`);

    log("\n▶ the SDK treats the network as its own registry");
    assert(!isCachedRegistry(network), "no registry on another chain");
    assert(registryNetwork(network) === network, "registryNetwork is the network itself");
    let refusedCache = "";
    try { keyStoreCacheOf(network); } catch (e) { refusedCache = (e as Error).message; }
    assert(/keeps its KeyStore locally/.test(refusedCache), "there is no cache to prove into");
    assert(needsFirstActionPrepend(network, "admin"), "an admin's first action carries the registration");

    // A fresh wallet, holding the chain's own currency only.
    const admin = privateKeyToAccount(generatePrivateKey());
    const session = privateKeyToAccount(generatePrivateKey());
    const walletAddress = admin.address;
    await test.setBalance({ address: walletAddress, value: fee * 3n + parseEther("1") });
    const wallet = createWalletClient({ account: admin, chain: network.chain, transport });
    const send = async (call: { to: Address; value?: bigint; data?: Hex }) => {
      const hash = await wallet.sendTransaction({ to: call.to, value: call.value ?? 0n, data: call.data ?? "0x" });
      return pub.waitForTransactionReceipt({ hash });
    };
    const treasuryBefore = await pub.getBalance({ address: treasury });

    log("\n▶ first action: the SDK's prepend registers the main key");
    assert((await readActiveKeys(pub, network, walletAddress)).length === 0, "the wallet has no keys yet");
    const prepend = await buildFirstActionPrepend({ publicClient: pub, network, walletAddress, adminPublicKey: admin.publicKey });
    assert(prepend.length === 1, "one call is prepended");
    assert(prepend[0]!.to.toLowerCase() === network.keyStoreController.toLowerCase(), "it goes to the config's controller");
    assert(prepend[0]!.value === registrationValueFor(fee), "it carries the fee plus the SDK's margin");
    assertNoRegistryTargets(network, prepend);
    assert(true, "registry calls are allowed on this network");
    let refusedElsewhere = "";
    try { assertNoRegistryTargets(BASE_SEPOLIA, [{ ...prepend[0]!, to: BASE_SEPOLIA.keyStoreController }]); } catch (e) { refusedElsewhere = (e as Error).message; }
    assert(/KeyStoreController address of Sepolia/.test(refusedElsewhere), "and still refused on a network that keeps its registry elsewhere");
    assert((await send(prepend[0]!)).status === "success", "the registration transaction succeeded");
    const adminKeyId = deriveKeyId(admin.publicKey);
    assert(await readIsValidKey(pub, network, walletAddress, adminKeyId), "the main key is valid in the KeyStore");

    log("\n▶ a session key, registered with the SDK's registerKey call");
    const expiry = Number((await pub.getBlock()).timestamp) + 86_400;
    const register = buildAdditionalRegisterCall({ publicKey: session.publicKey, fee, network, expiry });
    assert((await send(register)).status === "success", "the registerKey transaction succeeded");
    const sessionKeyId = deriveKeyId(session.publicKey);
    assert(await readIsValidKey(pub, network, walletAddress, sessionKeyId), "the session key is valid in the KeyStore");
    assert((await readActiveKeys(pub, network, walletAddress)).length === 2, "the KeyStore holds two keys for the wallet");
    const received = (await pub.getBalance({ address: treasury })) - treasuryBefore;
    assert(received === fee * 2n, `the treasury received exactly two fees (${received} wei), so the margin came back`);

    log("\n▶ a registered wallet is not registered twice");
    const again = await buildFirstActionPrepend({ publicClient: pub, network, walletAddress, adminPublicKey: admin.publicKey });
    assert(again.length === 0, "nothing is prepended to its next action");

    log("\n▶ the session key is revoked with the SDK's revokeKey call");
    const revoke = buildRevokeKeyCall({ walletAddress, keyId: sessionKeyId, network });
    assert(revoke.to.toLowerCase() === network.keyStore.toLowerCase(), "the revoke goes to the config's KeyStore");
    assert((await send(revoke)).status === "success", "the revoke transaction succeeded");
    assert(!(await readIsValidKey(pub, network, walletAddress, sessionKeyId)), "the session key is no longer valid");
    assert(await readIsValidKey(pub, network, walletAddress, adminKeyId), "the main key is still valid");
  } finally {
    anvil.kill();
  }
}

main()
  .then(() => {
    log(failed === 0 ? "\nPASS" : `\nFAIL: ${failed} check(s)`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error("FAILED:", (e as Error).message);
    process.exit(1);
  });
