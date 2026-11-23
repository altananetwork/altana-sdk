/**
 * What the relay is asked to prepare when a client sends a transaction: the
 * caller's calls with the attribution tag by default, with the app's own code
 * when set, untouched when attribution is off, and untagged on a second try
 * when the relay refuses the tagged ones before anything is signed.
 *
 * Runs over a mocked fetch that plays the relay and the account.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { encodeAbiParameters, encodeFunctionData, erc20Abi, numberToHex, type Address, type Hex } from "viem";
import { CELO_SEPOLIA } from "./config.js";
import { createClient } from "./client.js";
import { createPrivateKeySigner } from "./internal/signer.js";
import { parseAttribution } from "./attribution.js";
import capabilities from "./internal/fixtures/celo-sepolia-capabilities.json" with { type: "json" };
import prepared from "./internal/fixtures/celo-sepolia-prepare-calls.json" with { type: "json" };

const TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const FRIEND = "0x2222222222222222222222222222222222222222" as Address;
const transfer = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [FRIEND, 1_000n] });
const CALL = { to: TOKEN, data: transfer };
const GET_NONCE_SELECTOR = "0x3e1b0812";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Sent = { to: string; data?: string; value?: string };

/** Plays the relay. `refuseTagged` makes it refuse any prepare whose calls carry a tag. */
function mockWire(opts: { refuseTagged?: boolean; refuseAll?: boolean } = {}) {
  const prepares: Sent[][] = [];
  let sends = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: any }) => {
      const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
      if (req.method === "eth_call") {
        const data = String(req.params?.[0]?.data ?? "");
        if (String(req.params?.[0]?.to ?? "").toLowerCase() === CELO_SEPOLIA.keyStore.toLowerCase()) {
          return ok(encodeAbiParameters([{ type: "bytes32[]" }], [[`0x${"01".repeat(32)}` as Hex]]));
        }
        if (data.startsWith(GET_NONCE_SELECTOR)) return ok(numberToHex(0n, { size: 32 }));
        return ok("0x");
      }
      if (req.method === "eth_chainId") return ok(numberToHex(CELO_SEPOLIA.chainId));
      if (req.method === "wallet_getCapabilities") return ok({ [numberToHex(CELO_SEPOLIA.chainId)]: capabilities["0xaa044c"] });
      if (req.method === "wallet_getAssets") {
        return ok({ [numberToHex(CELO_SEPOLIA.chainId)]: [{ address: "native", balance: numberToHex(10n ** 18n), type: "native", metadata: null }] });
      }
      if (req.method === "wallet_prepareCalls") {
        const calls = (req.params?.[0]?.calls ?? []) as Sent[];
        prepares.push(calls);
        const carriesTag = calls.some((c) => parseAttribution((c.data ?? "0x") as Hex) !== undefined);
        if (opts.refuseAll || (opts.refuseTagged && carriesTag)) {
          return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted" } };
        }
        return ok(prepared);
      }
      if (req.method === "wallet_sendPreparedCalls") {
        sends += 1;
        return ok({ id: "0x01" });
      }
      if (req.method === "wallet_getCallsStatus") {
        return ok({
          id: req.params?.[0],
          status: 200,
          receipts: [
            {
              chainId: numberToHex(CELO_SEPOLIA.chainId),
              transactionHash: `0x${"ab".repeat(32)}`,
              status: "0x1",
              blockNumber: "0x1",
              blockHash: `0x${"cd".repeat(32)}`,
              gasUsed: "0x1",
              logs: [],
            },
          ],
        });
      }
      throw new Error(`unexpected ${req.method}`);
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), { status: 200 });
  }) as typeof fetch;
  return { prepares, sends: () => sends };
}

let seq = 0xa0;
const wallet = () => ({ address: `0x${(seq++).toString(16).padStart(40, "0")}` as Address });
const codesOf = (calls: Sent[]) => parseAttribution((calls.at(-1)!.data ?? "0x") as Hex)?.codes;
const base = { chains: [CELO_SEPOLIA], agentIdentity: false as const };

describe("client.execute and the attribution tag", () => {
  test("on by default: the call carries altana", async () => {
    const wire = mockWire();
    const res = await createClient(base).execute({ wallet: wallet(), signer: createPrivateKeySigner(), calls: CALL });
    expect(res.status).toBe("CONFIRMED");
    expect(wire.prepares).toHaveLength(1);
    expect(codesOf(wire.prepares[0]!)).toEqual(["altana"]);
    expect(wire.prepares[0]![0]!.data!.startsWith(transfer)).toBe(true);
  });

  test("appCode adds the app's own code after altana", async () => {
    const wire = mockWire();
    await createClient({ ...base, appCode: "my_app" }).execute({ wallet: wallet(), signer: createPrivateKeySigner(), calls: CALL });
    expect(codesOf(wire.prepares[0]!)).toEqual(["altana", "my_app"]);
  });

  test("attribution: false sends the caller's bytes exactly", async () => {
    const wire = mockWire();
    await createClient({ ...base, appCode: "my_app", attribution: false }).execute({ wallet: wallet(), signer: createPrivateKeySigner(), calls: CALL });
    expect(wire.prepares[0]![0]!.data).toBe(transfer);
  });

  test("a bad app code is refused when the client is created", () => {
    expect(() => createClient({ ...base, appCode: "My App" })).toThrow(/lowercase letters, digits and underscores/);
  });

  test("the quote is for the same tagged bytes", async () => {
    const wire = mockWire();
    await createClient({ ...base, appCode: "my_app" }).quoteExecute({ wallet: wallet(), signer: createPrivateKeySigner(), calls: CALL });
    expect(codesOf(wire.prepares[0]!)).toEqual(["altana", "my_app"]);
    expect(wire.sends()).toBe(0);
  });
});

describe("when the relay refuses the tagged calls", () => {
  test("they are prepared once more without the tag, and sent once", async () => {
    const wire = mockWire({ refuseTagged: true });
    const res = await createClient(base).execute({ wallet: wallet(), signer: createPrivateKeySigner(), calls: CALL });
    expect(res.status).toBe("CONFIRMED");
    expect(wire.prepares).toHaveLength(2);
    expect(codesOf(wire.prepares[0]!)).toEqual(["altana"]);
    expect(wire.prepares[1]![0]!.data).toBe(transfer);
    expect(wire.sends()).toBe(1);
  });

  test("a refusal that is not about the tag is still a refusal, and nothing is sent", async () => {
    const wire = mockWire({ refuseAll: true });
    await expect(createClient(base).execute({ wallet: wallet(), signer: createPrivateKeySigner(), calls: CALL })).rejects.toThrow();
    expect(wire.prepares.at(-1)![0]!.data).toBe(transfer);
    expect(wire.sends()).toBe(0);
  });

  test("with attribution off there is no second try", async () => {
    const wire = mockWire({ refuseAll: true });
    await expect(
      createClient({ ...base, attribution: false }).execute({ wallet: wallet(), signer: createPrivateKeySigner(), calls: CALL }),
    ).rejects.toThrow();
    expect(wire.prepares).toHaveLength(1);
  });
});
