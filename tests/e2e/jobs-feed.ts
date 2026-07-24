/**
 * Live feed of the ERC-8183 agent economy — tails JobCreated / JobFunded /
 * JobSubmitted / JobFinalised events from the kernel and prints them.
 *
 * Run: bun run jobs-feed.ts [mainnet|testnet]   (default mainnet; Ctrl-C to stop)
 */
import { createPublicClient, http, formatUnits } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { erc8183Addresses } from "@altananetwork/sdk";

const net = process.argv[2] === "testnet" ? { chain: bscTestnet, chainId: 97, rpc: "https://bsc-testnet-dataseed.bnbchain.org" } : { chain: bsc, chainId: 56, rpc: "https://bsc-dataseed.binance.org" };
const A = erc8183Addresses(net.chainId);
const client = createPublicClient({ chain: net.chain, transport: http(net.rpc) });

const EVENTS = [
  { type: "event", name: "JobCreated", inputs: [
    { name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true },
    { name: "provider", type: "address", indexed: true }, { name: "evaluator", type: "address", indexed: false },
    { name: "expiredAt", type: "uint256", indexed: false }, { name: "hook", type: "address", indexed: false } ] },
  { type: "event", name: "JobFunded", inputs: [
    { name: "jobId", type: "uint256", indexed: true }, { name: "client", type: "address", indexed: true },
    { name: "provider", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false } ] },
  { type: "event", name: "JobSubmitted", inputs: [
    { name: "jobId", type: "uint256", indexed: true }, { name: "provider", type: "address", indexed: true },
    { name: "deliverable", type: "bytes32", indexed: false } ] },
] as const;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
console.log(`⛓  tailing ERC-8183 kernel ${A.commerce} on ${net.chain.name} — Ctrl-C to stop\n`);

client.watchEvent({
  address: A.commerce,
  events: EVENTS as never,
  pollingInterval: 5_000,
  onLogs: (logs) => {
    for (const log of logs as never[]) {
      const l = log as { eventName: string; args: Record<string, unknown> };
      const t = new Date().toISOString().slice(11, 19);
      const id = l.args.jobId;
      if (l.eventName === "JobCreated") console.log(`${t}  🆕 job ${id}  client ${short(String(l.args.client))} → provider ${short(String(l.args.provider))}`);
      if (l.eventName === "JobFunded") console.log(`${t}  💰 job ${id}  FUNDED ${formatUnits(l.args.amount as bigint, 18)} $U  (${short(String(l.args.client))} → ${short(String(l.args.provider))})`);
      if (l.eventName === "JobSubmitted") console.log(`${t}  📦 job ${id}  deliverable submitted by ${short(String(l.args.provider))}`);
    }
  },
  onError: () => {},
});
