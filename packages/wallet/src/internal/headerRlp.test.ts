/**
 * The L1 header RLP encoder, against real Sepolia headers from either side of
 * Glamsterdam.
 *
 * The encoder's whole job is to reproduce the hash the chain computed, and
 * `buildPopulateKeyCall` refuses to build a proof when it cannot. Glamsterdam
 * (Ethereum Sepolia block 11856337, 2026-10-06 13:53:36 UTC) appended
 * `blockAccessListHash` and `slotNumber`, so a pre-fork encoder produced the
 * wrong hash for every post-fork anchor and mirror proofs stopped being
 * buildable.
 *
 * **Both directions are asserted on purpose.** Optional fields are encoded only
 * when present, so a pre-fork header must still verify: existing cache entries
 * and any proof built before the fork depend on it.
 *
 * These fixtures are captured headers, which qa's point makes worth stating:
 * a fixture is a measurement of the day it was taken, so a suite of fixtures
 * alone would have kept passing through the fork. `tests/e2e` re-encodes a
 * *live* recent header for that reason.
 */
import { describe, expect, test } from "bun:test";
import { keccak256 } from "viem";
import { rlpEncodeHeader } from "../syncKeyToL2.js";
import pre from "./fixtures/sepolia-header-pre-glamsterdam.json" with { type: "json" };
import post from "./fixtures/sepolia-header-post-glamsterdam.json" with { type: "json" };

const countFields = (h: Record<string, unknown>) =>
  Object.keys(h).filter((k) => k !== "hash").length;

describe("rlpEncodeHeader", () => {
  test("a post-fork header re-encodes to its own hash", () => {
    expect(keccak256(rlpEncodeHeader(post))).toBe((post as { hash: string }).hash);
  });

  test("a pre-fork header still re-encodes to its own hash", () => {
    expect(keccak256(rlpEncodeHeader(pre))).toBe((pre as { hash: string }).hash);
  });

  test("the fixtures really are from either side of the fork", () => {
    expect(countFields(pre as any)).toBe(21);
    expect(countFields(post as any)).toBe(23);
    expect((pre as any).blockAccessListHash).toBeUndefined();
    expect((pre as any).slotNumber).toBeUndefined();
    expect((post as any).blockAccessListHash).toBeDefined();
    expect((post as any).slotNumber).toBeDefined();
    expect(BigInt((pre as any).number)).toBeLessThan(11856337n);
    expect(BigInt((post as any).number)).toBeGreaterThanOrEqual(11856337n);
  });

  test("the two new fields are appended in that order, and the reverse does not hash", () => {
    // Measured, not assumed: this is what distinguished the two candidate orders.
    const reversed = {
      ...(post as any),
      blockAccessListHash: (post as any).slotNumber,
      slotNumber: (post as any).blockAccessListHash,
    };
    expect(keccak256(rlpEncodeHeader(reversed))).not.toBe((post as any).hash);
  });

  test("dropping either new field breaks a post-fork header", () => {
    for (const k of ["blockAccessListHash", "slotNumber"]) {
      const without: any = { ...(post as any) };
      delete without[k];
      expect(keccak256(rlpEncodeHeader(without))).not.toBe((post as any).hash);
    }
  });

  test("adding the new fields to a pre-fork header breaks it", () => {
    const withNew = {
      ...(pre as any),
      blockAccessListHash: (post as any).blockAccessListHash,
      slotNumber: (post as any).slotNumber,
    };
    expect(keccak256(rlpEncodeHeader(withNew))).not.toBe((pre as any).hash);
  });
});
