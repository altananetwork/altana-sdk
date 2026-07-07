import type { Address, Hex } from "viem";

/**
 * A wallet handle. The smart-account address is the same on every chain the
 * client is configured for (it is the EIP-7702 EOA address), so a Wallet is
 * not bound to a single network. Does NOT carry a private key — the
 * integrator manages signers separately.
 */
export type Wallet = {
  address: Address;
};

/** Result of a successful execute() call. */
export type ExecuteResult = {
  callsId: Hex;
  transactionHash?: Hex;
  status: "PENDING" | "CONFIRMED" | "FAILED";
};
