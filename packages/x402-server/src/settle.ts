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

export type SettleResult = { txHash: Hex };

/**
 * Broadcast the payment on-chain from the facilitator wallet and wait for
 * inclusion. Reverts (wrong signature, replayed nonce, insufficient balance)
 * surface as thrown errors — the caller answers 402.
 */
export async function settlePayment(
  d: DecodedPayment,
  cfg: MerchantConfig,
  clients: { wallet: WalletClient; public: PublicClient },
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

  const account = clients.wallet.account;
  if (!account) throw new Error("settle: facilitator wallet client has no account");
  const txHash = await clients.wallet.sendTransaction({ account, to, data, chain: clients.wallet.chain });
  const receipt = await clients.public.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") {
    throw new Error(`settle: transaction ${txHash} reverted`);
  }
  return { txHash };
}
