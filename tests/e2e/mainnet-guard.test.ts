import { afterEach, describe, expect, test } from "bun:test";
import { celoMainnetForScript, confirmMainnetSend, transactionLine } from "./mainnet-guard.js";

/**
 * The guard in front of every mainnet send in the live scripts. A script that
 * moves real funds must never be redirected to another relay, and must never
 * send without the owner asking for it.
 */
const BASE = { publicRpcUrl: "https://forno.celo.org", relayUrl: "https://relay.altana.network" };
const saved = { rpc: process.env.CELO_MAINNET_RPC_URL, relay: process.env.CELO_REHEARSAL_RELAY_URL };
afterEach(() => {
  for (const [k, v] of [["CELO_MAINNET_RPC_URL", saved.rpc], ["CELO_REHEARSAL_RELAY_URL", saved.relay]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const env = (rpc?: string, relay?: string) => {
  if (rpc === undefined) delete process.env.CELO_MAINNET_RPC_URL; else process.env.CELO_MAINNET_RPC_URL = rpc;
  if (relay === undefined) delete process.env.CELO_REHEARSAL_RELAY_URL; else process.env.CELO_REHEARSAL_RELAY_URL = relay;
};

describe("the network a live script runs on", () => {
  test("with nothing set it is the SDK's own Celo config, and not a rehearsal", () => {
    env();
    expect(celoMainnetForScript(BASE)).toEqual({ network: BASE, rehearsal: false });
  });

  test("an RPC override changes the reads only: the relay stays the real one", () => {
    env("https://paid-rpc.example/key");
    const { network, rehearsal } = celoMainnetForScript(BASE);
    expect(network).toEqual({ publicRpcUrl: "https://paid-rpc.example/key", relayUrl: BASE.relayUrl });
    expect(rehearsal).toBe(false);
  });

  test("a rehearsal needs BOTH the RPC and the relay on this machine", () => {
    env("http://127.0.0.1:9045", "http://127.0.0.1:19719");
    expect(celoMainnetForScript(BASE)).toEqual({ network: { publicRpcUrl: "http://127.0.0.1:9045", relayUrl: "http://127.0.0.1:19719" }, rehearsal: true });
    env("http://localhost:9045", "http://localhost:19719");
    expect(celoMainnetForScript(BASE).rehearsal).toBe(true);
  });

  test("a relay override with the real chain is refused", () => {
    env(undefined, "http://127.0.0.1:19719");
    expect(() => celoMainnetForScript(BASE)).toThrow(/both be on 127\.0\.0\.1/);
    env("https://forno.celo.org", "http://127.0.0.1:19719");
    expect(() => celoMainnetForScript(BASE)).toThrow(/both be on 127\.0\.0\.1/);
  });

  test("a relay override that is not on this machine is refused, even with a local RPC", () => {
    env("http://127.0.0.1:9045", "https://other-relay.example");
    expect(() => celoMainnetForScript(BASE)).toThrow(/both be on 127\.0\.0\.1/);
    env("http://127.0.0.1:9045", "http://127.0.0.1.evil.example:19719");
    expect(() => celoMainnetForScript(BASE)).toThrow(/both be on 127\.0\.0\.1/);
  });

  test("a local RPC without a local relay is refused: a fork must never be read while the real relay is used", () => {
    env("http://127.0.0.1:9045");
    expect(() => celoMainnetForScript(BASE)).toThrow(/set CELO_REHEARSAL_RELAY_URL/);
  });
});

describe("the confirmation in front of a send", () => {
  test("without --i-am-doris nothing is asked and nothing is sent", async () => {
    await expect(confirmMainnetSend({ args: ["--send"], what: "real CELO", phrase: "spend real CELO" })).rejects.toThrow(/add --i-am-doris/);
  });

  test("with the flag but no interactive terminal it still refuses", async () => {
    const wasTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(confirmMainnetSend({ args: ["--send", "--i-am-doris"], what: "real CELO", phrase: "spend real CELO" })).rejects.toThrow(/interactive terminal/);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: wasTTY, configurable: true });
    }
  });
});

describe("how a transaction is printed", () => {
  test("an explorer link on the real chain, the bare hash in a rehearsal, nothing without a hash", () => {
    expect(transactionLine("https://celoscan.io", "0xabc", false)).toBe("https://celoscan.io/tx/0xabc");
    expect(transactionLine("https://celoscan.io", "0xabc", true)).toBe("0xabc (local fork)");
    expect(transactionLine("https://celoscan.io", undefined, false)).toBe("");
  });
});
