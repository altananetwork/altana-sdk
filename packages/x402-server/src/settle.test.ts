/**
 * settlePayment classifies outcomes, not errors (#76):
 *
 *  - nothing broadcast / reverted / replaced  → throws (402 is right)
 *  - broadcast, receipt unreadable            → { settlement: "pending", txHash }
 *
 * An outcome that could not be determined is never "did not happen".
 */
import { describe, expect, test } from "bun:test";
import { keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { describeError, settlePayment, type SettleClients } from "./settle.js";
import { U_TOKEN } from "./tokens.js";
import type { DecodedPayment, MerchantConfig } from "./types.js";

const PAY_TO = "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA" as const;
const CFG: MerchantConfig = { chainId: 56, payTo: PAY_TO, price: 5n, rails: [{ rail: "eip3009", token: U_TOKEN[56] }] };
const PAYMENT: DecodedPayment = {
  rail: "eip3009",
  payer: "0x00000000000000000000000000000000000000a0",
  amount: 5n,
  token: U_TOKEN[56].address,
  signature: ("0x" + "ab".repeat(65)) as Hex,
  authorization: { from: "0x00000000000000000000000000000000000000a0", to: PAY_TO, value: "5", validAfter: "0", validBefore: "1", nonce: ("0x" + "11".repeat(32)) as Hex },
  raw: {},
};

/** A viem-shaped error: the long message carries the RPC URL, shortMessage does not. */
function rpcError(short: string, details?: string) {
  return Object.assign(new Error(`${short}\n\nURL: http://rpc.example/?key=SECRET\nDetails: ${details ?? ""}`), {
    shortMessage: short,
    details,
  });
}

type Fakes = {
  sendRaw?: (raw: Hex) => Promise<unknown>;
  getTransaction?: () => Promise<unknown>;
  receipt?: (hash: Hex) => Promise<{ transactionHash: Hex; status: "success" | "reverted" }>;
};
/** Fake clients around a real local signer: signing is real, the chain is not. */
function fakeClients(f: Fakes = {}) {
  const account = privateKeyToAccount(generatePrivateKey());
  const calls = { sendRaw: 0, sendTransaction: 0, raws: [] as Hex[] };
  const clients = {
    wallet: {
      account,
      chain: undefined,
      prepareTransactionRequest: async (req: Record<string, unknown>) => ({
        ...req, chainId: 56, nonce: 0, gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, type: "eip1559",
      }),
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        calls.sendRaw++;
        calls.raws.push(serializedTransaction);
        return f.sendRaw ? f.sendRaw(serializedTransaction) : keccak256(serializedTransaction);
      },
      // Only used for non-local signers; kept so the pre-#76 code path is also exercisable.
      sendTransaction: async () => { calls.sendTransaction++; return ("0x" + "cd".repeat(32)) as Hex; },
    },
    public: {
      getTransaction: async () => (f.getTransaction ? f.getTransaction() : null),
      getTransactionReceipt: async () => null,
      waitForTransactionReceipt: async ({ hash }: { hash: Hex }) =>
        f.receipt ? f.receipt(hash) : { transactionHash: hash, status: "success" as const },
    },
  };
  return { clients: clients as unknown as SettleClients, calls };
}

describe("settlePayment outcome classification", () => {
  test("happy path: confirmed, with the hash of what was actually broadcast", async () => {
    const { clients, calls } = fakeClients();
    const r = await settlePayment(PAYMENT, CFG, clients);
    expect(r.settlement).toBe("confirmed");
    expect(r.txHash).toBe(keccak256(calls.raws[0]!));
    expect(calls.sendTransaction).toBe(0); // local signer: hash known before broadcast
  });

  test("receipt read fails after a successful broadcast → pending with the hash, no throw", async () => {
    const { clients, calls } = fakeClients({
      receipt: async () => { throw rpcError("Missing or invalid parameters.", "receipt read unavailable"); },
    });
    const r = await settlePayment(PAYMENT, CFG, clients);
    expect(r.settlement).toBe("pending");
    expect(r.txHash).toBe(keccak256(calls.raws[0]!));
    expect(r.pendingReason).toBe("Missing or invalid parameters. (receipt read unavailable)");
    expect(r.pendingReason).not.toContain("http"); // never the RPC URL
  });

  test("receipt wait times out → pending", async () => {
    const { clients } = fakeClients({ receipt: async () => { throw rpcError("Timed out while waiting for transaction."); } });
    const r = await settlePayment(PAYMENT, CFG, clients, { receiptTimeoutMs: 1 });
    expect(r.settlement).toBe("pending");
  });

  test("broadcast fails and the node does not know the tx → throws (nothing happened)", async () => {
    const { clients } = fakeClients({ sendRaw: async () => { throw rpcError("Execution reverted with reason: Authorization already used."); } });
    await expect(settlePayment(PAYMENT, CFG, clients)).rejects.toThrow("Authorization already used");
  });

  test("broadcast 'fails' but the node already has the tx (lost response, retry told 'already known') → not a failure", async () => {
    const { clients, calls } = fakeClients({
      sendRaw: async () => { throw rpcError("Nonce provided for the transaction is lower than the current nonce.", "already known"); },
      getTransaction: async () => ({ hash: "0x" }),
    });
    const r = await settlePayment(PAYMENT, CFG, clients);
    expect(r.settlement).toBe("confirmed");
    expect(r.txHash).toBe(keccak256(calls.raws[0]!));
  });

  test("gas estimation / preparation fails → throws before anything is signed", async () => {
    const { clients, calls } = fakeClients();
    (clients.wallet as { prepareTransactionRequest: unknown }).prepareTransactionRequest = async () => {
      throw rpcError("Execution reverted with reason: invalid signature.");
    };
    await expect(settlePayment(PAYMENT, CFG, clients)).rejects.toThrow("invalid signature");
    expect(calls.sendRaw).toBe(0);
  });

  test("transaction reverted on-chain → throws (nonce unspent, retry is fine)", async () => {
    const { clients } = fakeClients({ receipt: async (hash) => ({ transactionHash: hash, status: "reverted" }) });
    await expect(settlePayment(PAYMENT, CFG, clients)).rejects.toThrow(/reverted/);
  });

  test("a same-nonce replacement landed instead of ours → throws (ours can never land)", async () => {
    const { clients } = fakeClients({ receipt: async () => ({ transactionHash: ("0x" + "ee".repeat(32)) as Hex, status: "success" }) });
    await expect(settlePayment(PAYMENT, CFG, clients)).rejects.toThrow(/replaced/);
  });

  test("non-local signer falls back to sendTransaction", async () => {
    const { clients, calls } = fakeClients();
    (clients.wallet as { account: unknown }).account = { address: "0x00000000000000000000000000000000000000B0", type: "json-rpc" };
    const r = await settlePayment(PAYMENT, CFG, clients);
    expect(r.settlement).toBe("confirmed");
    expect(calls.sendTransaction).toBe(1);
    expect(calls.sendRaw).toBe(0);
  });
});

describe("describeError", () => {
  test("keeps viem's one-liner and the node detail, drops the URL/request dump", () => {
    const msg = describeError(rpcError("Missing or invalid parameters.", "receipt read unavailable"));
    expect(msg).toBe("Missing or invalid parameters. (receipt read unavailable)");
  });
  test("does not repeat a detail already in the short message", () => {
    expect(describeError(rpcError("Execution reverted with reason: boom.", "reason: boom"))).toBe("Execution reverted with reason: boom.");
  });
  test("plain errors pass through", () => {
    expect(describeError(new Error("settle: transaction 0x1 reverted"))).toBe("settle: transaction 0x1 reverted");
  });
});
