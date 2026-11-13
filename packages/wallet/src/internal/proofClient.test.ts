/**
 * The client a KeyStoreCache proof is built with. A registry chain's default
 * RPC often refuses `eth_getProof` at the block an L2 anchors, so the proof
 * client walks the network's `proofRpcUrls` and only then its `publicRpcUrl`.
 * Real HTTP servers stand in for the endpoints: what is under test is which
 * endpoint answers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { CELO, ETHEREUM, SEPOLIA, type NetworkConfig } from "../config.js";
import { buildProofClient } from "./relay.js";

type Rpc = { method: string; id: number };
const hits: string[] = [];

function endpoint(name: string, answer: (rpc: Rpc) => unknown) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const rpc = (await req.json()) as Rpc;
      hits.push(`${name}:${rpc.method}`);
      const body = answer(rpc);
      if (body instanceof Response) return body;
      return Response.json({ jsonrpc: "2.0", id: rpc.id, ...(body as object) });
    },
  });
}

const PROOF = {
  address: ETHEREUM.keyStore,
  accountProof: ["0x01"],
  balance: "0x0",
  codeHash: `0x${"00".repeat(32)}`,
  nonce: "0x0",
  storageHash: `0x${"00".repeat(32)}`,
  storageProof: [{ key: `0x${"00".repeat(32)}`, value: "0x0", proof: ["0x02"] }],
};

const refusesByRpcError = endpoint("shallow", () => ({
  error: { code: -32602, message: "Archive requests require a personal token." },
}));
const refusesByHttp = endpoint("forbidden", () => new Response("forbidden", { status: 403 }));
const serves = endpoint("deep", () => ({ result: PROOF }));
const url = (s: { port: number }) => `http://127.0.0.1:${s.port}`;

afterAll(() => {
  refusesByRpcError.stop(true);
  refusesByHttp.stop(true);
  serves.stop(true);
});

const getProof = (network: NetworkConfig) =>
  buildProofClient(network).getProof({
    address: ETHEREUM.keyStore,
    storageKeys: [`0x${"00".repeat(32)}`],
    blockNumber: 100n,
  });

describe("buildProofClient", () => {
  test("moves past endpoints that refuse the block, whether by RPC error or HTTP status", async () => {
    hits.length = 0;
    const proof = await getProof({
      ...ETHEREUM,
      publicRpcUrl: url(refusesByRpcError),
      proofRpcUrls: [url(refusesByRpcError), url(refusesByHttp), url(serves)],
    });
    expect(proof.accountProof).toEqual(["0x01"]);
    expect(hits.at(-1)).toBe("deep:eth_getProof");
    expect(hits).toContain("shallow:eth_getProof");
    expect(hits).toContain("forbidden:eth_getProof");
  });

  test("falls back to publicRpcUrl after the proof endpoints", async () => {
    hits.length = 0;
    const proof = await getProof({
      ...ETHEREUM,
      publicRpcUrl: url(serves),
      proofRpcUrls: [url(refusesByHttp)],
    });
    expect(proof.storageProof[0]!.proof).toEqual(["0x02"]);
    expect(hits.at(-1)).toBe("deep:eth_getProof");
  });

  test("a network without proofRpcUrls reads from publicRpcUrl alone", async () => {
    hits.length = 0;
    const { proofRpcUrls: _unused, ...plain } = ETHEREUM;
    await getProof({ ...plain, publicRpcUrl: url(serves) });
    expect(hits).toEqual(["deep:eth_getProof"]);
  });

  test("when every endpoint refuses, the last refusal is what the caller sees", async () => {
    await expect(
      getProof({
        ...ETHEREUM,
        publicRpcUrl: url(refusesByRpcError),
        proofRpcUrls: [url(refusesByHttp)],
      }),
    ).rejects.toThrow(/Archive requests/);
  });
});

describe("the registry chains behind the cached networks", () => {
  test("Ethereum, the registry behind Celo, carries proof endpoints", () => {
    if (CELO.registry?.kind !== "cached") throw new Error("CELO must be a cached network");
    expect(CELO.registry.l1).toBe(ETHEREUM);
    expect(ETHEREUM.proofRpcUrls?.length).toBeGreaterThanOrEqual(2);
    for (const u of ETHEREUM.proofRpcUrls ?? []) expect(u).toMatch(/^https:\/\//);
  });

  test("Sepolia keeps its single endpoint, which already serves the anchored block", () => {
    expect(SEPOLIA.proofRpcUrls).toBeUndefined();
  });
});
