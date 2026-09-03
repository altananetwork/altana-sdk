import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { PERMIT2_ADDRESS } from "@altananetwork/sdk";
import type { DecodedPayment, MerchantConfig } from "./types.js";

/** FiatTokenV2_2-style EIP-3009 with a `bytes` signature (EOA 65-byte sigs and
 * ERC-1271-aware deployments alike). $U exposes this on both BSC networks. */
const EIP3009_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const PERMIT2_ABI = [
  {
    name: "permitTransferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "permit", type: "tuple", components: [
        { name: "permitted", type: "tuple", components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ] },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ] },
      { name: "transferDetails", type: "tuple", components: [
        { name: "to", type: "address" },
        { name: "requestedAmount", type: "uint256" },
      ] },
      { name: "owner", type: "address" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "permitWitnessTransferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "permit", type: "tuple", components: [
        { name: "permitted", type: "tuple", components: [
          { name: "token", type: "address" },
          { name: "amount", type: "uint256" },
        ] },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ] },
      { name: "transferDetails", type: "tuple", components: [
        { name: "to", type: "address" },
        { name: "requestedAmount", type: "uint256" },
      ] },
      { name: "owner", type: "address" },
      { name: "witness", type: "bytes32" },
      { name: "witnessTypeString", type: "string" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/**
 * The witness type-string suffix Permit2 appends to its
 * `PermitWitnessTransferFrom(...,` typehash stub. Must reproduce the exact
 * EIP-712 encoding of `buildPermit2WitnessTypedData` (the B402 permit2-exact
 * digest): referenced types sorted alphabetically after the primary type.
 */
const WITNESS_TYPE_STRING =
  "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)";

const WITNESS_TYPEHASH = keccak256(toHex("Witness(address to,uint256 validAfter)"));

export function witnessHash(to: Address, validAfter: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [WITNESS_TYPEHASH, to, validAfter],
    ),
  );
}

/** What settlement is allowed to touch. A merchant may inject its own clients. */
export type SettleClients = {
  wallet: Pick<WalletClient, "account" | "chain" | "sendTransaction" | "prepareTransactionRequest" | "sendRawTransaction">;
  public: Pick<PublicClient, "getTransaction" | "getTransactionReceipt" | "waitForTransactionReceipt">;
};

export type SettleOptions = {
  /** How long to wait for the receipt before reporting `pending` (default 60s). */
  receiptTimeoutMs?: number;
};

export type SettleResult = {
  txHash: Hex;
  /**
   * `confirmed`: the receipt was read and the transfer succeeded.
   * `pending`: the transaction was broadcast but its outcome could not be read
   * (RPC error, timeout). It will very likely land; reconcile against `txHash`.
   * A pending payment is never "did not happen" — answering a fresh challenge
   * would make the buyer pay twice (#76).
   */
  settlement: "confirmed" | "pending";
  /** Why the receipt was unavailable (`pending` only). No RPC URL, safe to log. */
  pendingReason?: string;
};

/** viem's one-line message plus the node's detail; never the URL/request dump. */
export function describeError(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; message?: string };
  const short = err?.shortMessage ?? err?.message ?? String(e);
  return err?.details && !short.includes(err.details) ? `${short} (${err.details})` : short;
}


/**
 * Broadcast the payment on-chain from the facilitator wallet and wait for
 * inclusion. Throws only when the payment definitely did not happen: nothing
 * was broadcast (wrong signature, replayed nonce, unfunded facilitator all
 * revert in gas estimation) or the transaction reverted / was replaced. Once a
 * transaction is out, an unreadable outcome returns `settlement: "pending"`
 * with the hash instead of throwing.
 */
export async function settlePayment(
  d: DecodedPayment,
  cfg: MerchantConfig,
  clients: SettleClients,
  opts: SettleOptions = {},
): Promise<SettleResult> {
  let to: Address;
  let data: Hex;

  if (d.rail === "eip3009") {
    const rail = cfg.rails.find((r) => r.rail === "eip3009");
    if (!rail) throw new Error("settle: no eip3009 rail configured");
    const a = d.authorization!;
    to = rail.token.address;
    data = encodeFunctionData({
      abi: EIP3009_ABI,
      functionName: "transferWithAuthorization",
      args: [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, d.signature],
    });
  } else {
    const p = d.permit!;
    const permit = {
      permitted: { token: p.permitted.token, amount: BigInt(p.permitted.amount) },
      nonce: BigInt(p.nonce),
      deadline: BigInt(p.deadline),
    };
    const transferDetails = { to: cfg.payTo, requestedAmount: BigInt(p.permitted.amount) };
    to = PERMIT2_ADDRESS;
    data =
      d.rail === "permit2-witness"
        ? encodeFunctionData({
            abi: PERMIT2_ABI,
            functionName: "permitWitnessTransferFrom",
            args: [
              permit,
              transferDetails,
              d.payer,
              witnessHash(p.witness!.to, BigInt(p.witness!.validAfter)),
              WITNESS_TYPE_STRING,
              d.signature,
            ],
          })
        : encodeFunctionData({
            abi: PERMIT2_ABI,
            functionName: "permitTransferFrom",
            args: [permit, transferDetails, d.payer, d.signature],
          });
  }

  const txHash = await broadcast(clients, { to, data });

  let receipt;
  try {
    receipt = await clients.public.waitForTransactionReceipt({
      hash: txHash,
      timeout: opts.receiptTimeoutMs ?? 60_000,
    });
  } catch (e) {
    // The transfer is in flight; the hash is the only evidence there is.
    return { txHash, settlement: "pending", pendingReason: describeError(e) };
  }
  if (receipt.transactionHash !== txHash) {
    // A same-nonce transaction from the facilitator superseded ours: this one
    // can never land, so the authorization is still unspent.
    throw new Error(`settle: transaction ${txHash} was replaced before inclusion`);
  }
  if (receipt.status !== "success") {
    throw new Error(`settle: transaction ${txHash} reverted`);
  }
  return { txHash, settlement: "confirmed" };
}

/**
 * Send the settlement transaction and return its hash. With a local signer the
 * hash is known before the broadcast, so a failed send is checked against the
 * node once: if the transaction is already there (the response was lost and
 * viem's retry was told "already known"), it is in flight, not failed.
 */
async function broadcast(clients: SettleClients, tx: { to: Address; data: Hex }): Promise<Hex> {
  const account = clients.wallet.account;
  if (!account) throw new Error("settle: facilitator wallet client has no account");
  const chain = clients.wallet.chain;

  if (account.type !== "local" || !account.signTransaction) {
    return clients.wallet.sendTransaction({ account, chain, ...tx });
  }
  const request = await clients.wallet.prepareTransactionRequest({ account, chain, ...tx });
  const serialized = await account.signTransaction(request as never, {
    serializer: chain?.serializers?.transaction,
  });
  const txHash = keccak256(serialized);
  try {
    await clients.wallet.sendRawTransaction({ serializedTransaction: serialized });
  } catch (e) {
    const known = await clients.public.getTransaction({ hash: txHash }).catch(() => null);
    if (!known) throw e;
  }
  return txHash;
}
