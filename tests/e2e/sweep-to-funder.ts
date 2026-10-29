/**
 * Return a throwaway wallet's leftover tBNB to the shared funder.
 *
 * Every test run that creates a wallet leaves a little behind, and the shared
 * funds rule says not to strand it. A wallet owned by a headless passkey can be
 * swept whenever its credential was kept, which is why scripts that make one
 * should print or save it.
 *
 *   # the credential as JSON, which is what createHeadlessPasskey gives you
 *   SWEEP_CREDENTIAL='{"kind":"headless","privateKey":"0x…","publicKey":"0x…"}' \
 *     bun run sweep-to-funder.ts 0xWalletAddress
 *
 *   # or by env var name, which is how .env.testnet stores them
 *   SWEEP_CREDENTIAL_VAR=SMOKE_PASSKEY_E84E3EE8_CREDENTIAL \
 *     bun run sweep-to-funder.ts 0xWalletAddress
 *
 *   # a plain EOA wallet instead of a passkey one
 *   SWEEP_PRIVATE_KEY=0x… bun run sweep-to-funder.ts
 *
 * Add AGENT_RPC_URL and AGENT_RELAY_URL to sweep on a fork instead of live.
 *
 * Nothing is printed that could expose a key: the credential is read from the
 * environment and never echoed.
 */

import {
  createClient,
  signerFromPasskey,
  signerFromPrivateKey,
  BNB_TESTNET,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { formatEther, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC_URL = process.env.AGENT_RPC_URL || BNB_TESTNET.publicRpcUrl;
const RELAY_URL = process.env.AGENT_RELAY_URL || BNB_TESTNET.relayUrl!;
const NETWORK: NetworkConfig = { ...BNB_TESTNET, publicRpcUrl: RPC_URL, relayUrl: RELAY_URL };

/**
 * Left behind so the sweep itself can pay its relay fee. The fee comes out of
 * the same balance, so sweeping the whole lot would leave nothing to pay with
 * and the transaction would simply fail.
 *
 * Read from the chain rather than fixed, because the first bundle from a wallet
 * that has never acted also pays the KeyStore registration fee, and that fee
 * comes from a Chainlink feed that moves with the BNB price. A flat constant
 * would be too small on a dear day and would waste tBNB on a cheap one.
 */
const REGISTRATION_FEE_ABI = [
  {
    name: "getRegistrationFeeInWei",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const FLOOR_MARGIN = parseEther("0.004");

async function feeMargin(delegated: boolean): Promise<bigint> {
  let registration = 0n;
  if (!delegated) {
    // An undelegated wallet's first bundle registers its admin key, which costs
    // the registration fee on top of gas.
    try {
      registration = (await publicClient.readContract({
        address: NETWORK.keyStoreController,
        abi: REGISTRATION_FEE_ABI,
        functionName: "getRegistrationFeeInWei",
      })) as bigint;
    } catch {
      // Fall through to the floor, which has covered it in practice.
    }
  }
  const gas = (await publicClient.getGasPrice().catch(() => 100_000_000n)) * 1_500_000n;
  const needed = registration * 2n + gas * 2n;
  return needed > FLOOR_MARGIN ? needed : FLOOR_MARGIN;
}

const FUNDER_KEY = process.env.TEST_FUNDER_KEY as Hex | undefined;
if (!FUNDER_KEY) throw new Error("TEST_FUNDER_KEY is not set. Load the shared .env.testnet.");
const funder = privateKeyToAccount(FUNDER_KEY);

function readCredential(): unknown | undefined {
  const byVar = process.env.SWEEP_CREDENTIAL_VAR;
  const raw = byVar ? process.env[byVar] : process.env.SWEEP_CREDENTIAL;
  if (!raw?.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      `The credential is not valid JSON. Expected {"kind":"headless","privateKey":"0x…","publicKey":"0x…"}.`,
    );
  }
}

function resolveSigner(): { signer: ReturnType<typeof signerFromPrivateKey>; wallet: Address } {
  const pk = process.env.SWEEP_PRIVATE_KEY as Hex | undefined;
  if (pk?.trim()) {
    const signer = signerFromPrivateKey(pk.trim() as Hex);
    // An EOA-owned wallet's address is the signer's own.
    const wallet = (process.argv[2] as Address | undefined) ?? signer.address;
    return { signer, wallet };
  }

  const credential = readCredential();
  if (!credential) {
    throw new Error(
      "Set SWEEP_CREDENTIAL, or SWEEP_CREDENTIAL_VAR naming an env var, or SWEEP_PRIVATE_KEY.",
    );
  }
  const wallet = process.argv[2] as Address | undefined;
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    throw new Error(
      "Pass the wallet address as the first argument. A passkey has no address of its own, so it cannot be derived.",
    );
  }
  return { signer: signerFromPasskey(credential as never) as never, wallet };
}

const { signer, wallet } = resolveSigner();
const publicClient = buildPublicClient(NETWORK);

console.log("Sweep leftover tBNB back to the funder");
console.log(`  wallet   ${wallet}`);
console.log(`  funder   ${funder.address}`);
console.log(`  rpc      ${RPC_URL}`);

const chainId = await publicClient.getChainId();
if (chainId !== 97) throw new Error(`expected chain 97, got ${chainId}`);

const balance = await publicClient.getBalance({ address: wallet });
console.log(`  balance  ${formatEther(balance)} tBNB`);

const code = await publicClient.getCode({ address: wallet }).catch(() => undefined);
const delegated = Boolean(code && code !== "0x");
const margin = await feeMargin(delegated);
console.log(`  delegated ${delegated ? "yes" : "no, so the first bundle also registers its key"}`);
console.log(`  keeping  ${formatEther(margin)} tBNB for the sweep's own fee`);

if (balance <= margin) {
  console.log(
    `\nNothing worth sweeping: ${formatEther(balance)} tBNB is at or below the ${formatEther(margin)} tBNB the sweep itself would cost.`,
  );
  process.exit(0);
}

const amount = balance - margin;
console.log(`  sending  ${formatEther(amount)} tBNB`);

const client = createClient({ chains: [NETWORK] });
const result = await client.execute({
  wallet: { address: wallet },
  signer,
  calls: { to: funder.address, value: amount, data: "0x" },
});

const landed = String(result.status).toUpperCase() === "CONFIRMED";
console.log(`\n  ${landed ? "swept" : "FAILED"}  ${result.status}  ${result.transactionHash ?? ""}`);
if (!landed) {
  // Say why. A bare "FAILED" sends the reader looking in the wrong place, and a
  // relay refusal usually names the cause.
  console.log(
    `  reason   ${JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`,
  );
  console.log(
    "  A relay failure here is often transient, and the funds are untouched, so try again.",
  );
}
if (landed && !RPC_URL.includes("127.0.0.1")) {
  console.log(`  https://testnet.bscscan.com/tx/${result.transactionHash}`);
}
const after = await publicClient.getBalance({ address: wallet });
console.log(`  left     ${formatEther(after)} tBNB`);
process.exit(landed ? 0 : 1);
