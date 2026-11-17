/**
 * Printing and asserting the per-chain legs of grantSession / revokeSession
 * in the live scripts.
 */
import type { SessionLeg } from "@altananetwork/sdk";

export function describeLeg(leg: SessionLeg): string {
  const parts = [`chain ${leg.chainId}`, leg.kind, leg.status];
  if (leg.via) parts.push(`via ${leg.via}`);
  if (leg.transactionHash) parts.push(`tx ${leg.transactionHash}`);
  if (leg.blockNumber !== undefined) parts.push(`block ${leg.blockNumber}`);
  if (leg.l1BlockNumber !== undefined) parts.push(`l1 block ${leg.l1BlockNumber}`);
  if (leg.reason) parts.push(`(${leg.reason.split("\n")[0]!.slice(0, 160)})`);
  return parts.join("  ");
}

export function printLegs(legs: readonly SessionLeg[], indent = "    "): void {
  for (const leg of legs) console.log(`${indent}${describeLeg(leg)}`);
}

/** Throws with every failed leg when the result is not the expected status. */
export function assertStatus(
  result: { status: string; legs: readonly SessionLeg[] },
  expected: "granted" | "revoked",
  what: string,
): void {
  if (result.status === expected) return;
  const failed = result.legs.filter((l) => l.status === "FAILED").map(describeLeg);
  throw new Error(`${what}: status ${result.status}; failed legs: ${failed.join(" | ") || "none"}`);
}

/** The one leg of a kind on a chain, or a thrown error naming what is missing. */
export function legOf(legs: readonly SessionLeg[], kind: SessionLeg["kind"], chainId: number): SessionLeg {
  const leg = legs.find((l) => l.kind === kind && l.chainId === chainId);
  if (!leg) throw new Error(`no ${kind} leg on chain ${chainId}`);
  return leg;
}

/** Signatures the flow asked for: one per submitted intent or direct transaction (bundled legs share one). */
export function signatureCount(legs: readonly SessionLeg[]): number {
  return legs.filter((l) => l.status !== "SKIPPED" && l.via !== "bundled" && l.transactionHash).length;
}
