import { CELO_SEPOLIA, SEPOLIA } from "@altananetwork/sdk";
import { describe, expect, test } from "vitest";
import { applyEnv, chainsFromEnv } from "../../src/lib/chains";

describe("chains", () => {
  test("env overrides relay and rpc urls", () => {
    const n = applyEnv(CELO_SEPOLIA, { VITE_RELAY_URL: "http://127.0.0.1:19131", VITE_RPC_11142220: "http://rpc" });
    expect(n.relayUrl).toBe("http://127.0.0.1:19131");
    expect(n.publicRpcUrl).toBe("http://rpc");
    expect(applyEnv(SEPOLIA, {}).publicRpcUrl).toBe(SEPOLIA.publicRpcUrl);
  });
  test("default order is Celo Sepolia first", () => {
    expect(chainsFromEnv({}).map((c) => c.chainId)).toEqual([11142220, 84532, 11155111]);
  });
});
