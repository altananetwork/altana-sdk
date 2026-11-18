/**
 * The guard every live script puts in front of a send on a mainnet: real funds
 * move, so the owner asks for it twice, the second time by typing a phrase at
 * an interactive terminal. Without it a script reads, quotes and prints only.
 */
import { createInterface } from "node:readline/promises";

export async function confirmMainnetSend(opts: {
  /** The flag list of the running script. */
  args: readonly string[];
  /** What will be spent and from where, as the prompt says it: "real USDC from 0x… on Celo mainnet". */
  what: string;
  /** The phrase to type. */
  phrase: string;
}): Promise<void> {
  if (!opts.args.includes("--i-am-doris")) {
    throw new Error("A send on mainnet spends real funds: add --i-am-doris. Nothing was sent.");
  }
  if (!process.stdin.isTTY) throw new Error("A send on mainnet needs an interactive terminal. Nothing was sent.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nThis spends ${opts.what}. Type "${opts.phrase}" to continue: `);
  rl.close();
  if (answer.trim() !== opts.phrase) throw new Error("Not confirmed. Nothing was sent.");
}

const isLocal = (url: string | undefined) => !!url && /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(url);

/**
 * The Celo mainnet config a live script runs on.
 *
 * `CELO_MAINNET_RPC_URL` overrides the RPC for the script's own reads. A
 * rehearsal on local forks sets it to the fork AND sets
 * `CELO_REHEARSAL_RELAY_URL` to a local relay. The two go together or not at
 * all: a relay override is honoured only when it and the RPC are both on this
 * machine, and a local RPC without a local relay is refused, so a script can
 * never read a fork while it spends through the real relay, or the reverse.
 */
export function celoMainnetForScript<T extends { publicRpcUrl: string; relayUrl?: string }>(base: T): { network: T; rehearsal: boolean } {
  const rpc = process.env.CELO_MAINNET_RPC_URL;
  const relay = process.env.CELO_REHEARSAL_RELAY_URL;
  if (relay && !(isLocal(relay) && isLocal(rpc))) {
    throw new Error("CELO_REHEARSAL_RELAY_URL is for a rehearsal on local forks: it and CELO_MAINNET_RPC_URL must both be on 127.0.0.1.");
  }
  if (isLocal(rpc) && !relay) {
    throw new Error("CELO_MAINNET_RPC_URL points at this machine, which is a rehearsal on a fork: set CELO_REHEARSAL_RELAY_URL to the local relay too.");
  }
  return {
    network: { ...base, ...(rpc ? { publicRpcUrl: rpc } : {}), ...(relay ? { relayUrl: relay } : {}) },
    rehearsal: Boolean(relay),
  };
}

/** How a script prints a transaction: an explorer link, or the bare hash in a rehearsal, where no explorer has it. */
export function transactionLine(explorer: string, hash: string | undefined, rehearsal: boolean): string {
  if (!hash) return "";
  return rehearsal ? `${hash} (local fork)` : `${explorer}/tx/${hash}`;
}
