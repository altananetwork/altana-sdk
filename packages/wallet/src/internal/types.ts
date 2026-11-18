import type { Address, Hex } from "viem";
import type { AgentIdentityOutcome } from "../agentIdentity.js";

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
  /**
   * The relay's raw EIP-5792 numeric status, when one was observed. Present
   * on CONFIRMED/FAILED and on a timed-out PENDING (the last code seen);
   * absent with `noWait` or when the relay never answered during the wait.
   */
  statusCode?: number;
  /**
   * The token the relay charged its fee in, read from the intent the relay
   * quoted (the zero address is the chain's native token). Absent only when
   * the relay's answer carried no quote.
   */
  feeToken?: Address;
  /**
   * Set when this was the wallet's first admin action: how the registration of
   * its agent identity went, in the transaction of its own that followed. The
   * action above is complete whatever this says. Absent on every other call,
   * and when `agentIdentity: false` was passed.
   */
  agentIdentity?: AgentIdentityOutcome;
};
