/**
 * One SDK instance, firing a session's transactions. Spawned by
 * `live-app-nonce-lane.ts` so the two-instance case is two real processes with
 * no shared lane state between them, which is the whole claim about per-key
 * lanes.
 *
 * Reads its work from env and prints one JSON line.
 */
import {
  CELO_SEPOLIA,
  SEPOLIA,
  createClient,
  deserializeSession,
  signerFromPrivateKey,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { parseEther, type Hex } from "viem";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";
const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  relayUrl: RELAY,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
  registry: {
    ...(CELO_SEPOLIA.registry as any),
    l1: { ...SEPOLIA, relayUrl: RELAY, publicRpcUrl: process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com" },
  },
} as NetworkConfig;

const label = process.env.WORKER_LABEL!;
const session = deserializeSession(
  JSON.parse(process.env.WORKER_SESSION!),
  signerFromPrivateKey(process.env.WORKER_SESSION_KEY as Hex),
);
const to = process.env.WORKER_TO as `0x${string}`;
const count = Number(process.env.WORKER_TX_COUNT ?? "2");
const client = createClient({ chains: [network] });

// Fired together, like an agent would: the lane has to sequence them.
const settled = await Promise.all(
  Array.from({ length: count }, (_, i) =>
    client
      .execute({ session, chainId: network.chainId, calls: { to, value: parseEther("0.001"), data: "0x" } })
      .then((r) => ({ i, ok: true as const, status: r.status, tx: r.transactionHash, callsId: r.callsId }))
      .catch((e) => ({ i, ok: false as const, error: (e as Error).message.split("\n")[0] })),
  ),
);

console.log(JSON.stringify({ label, publicKey: session.publicKey, settled }));
