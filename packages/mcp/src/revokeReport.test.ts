import { describe, expect, test } from "bun:test";
import type { SessionLeg } from "@altananetwork/sdk";
import { revokeFailureText, revokeReport } from "./revokeReport.js";

const confirmed = (chainId: number, kind: SessionLeg["kind"] = "account"): SessionLeg => ({
  chainId,
  kind,
  status: "CONFIRMED",
});

describe("revokeReport", () => {
  test("every leg confirmed: revoked, and the local session can go", () => {
    const report = revokeReport([confirmed(56), confirmed(56, "registry")]);

    expect(report.status).toBe("revoked");
    expect(report.forgetLocal).toBe(true);
    expect(report.note).toBeUndefined();
  });

  test("a cache proof still running does not hold the session back", () => {
    const report = revokeReport([confirmed(42220), confirmed(1, "registry"), { chainId: 42220, kind: "cache", status: "PENDING" }]);

    expect(report.status).toBe("revoked");
    expect(report.forgetLocal).toBe(true);
  });

  test("another chain that could not be read does not fail the call", () => {
    const report = revokeReport([
      confirmed(56),
      { chainId: 8453, kind: "account", status: "FAILED", reason: "could not read the account's keys: HTTP request failed", unread: true },
      { chainId: 1, kind: "registry", status: "FAILED", reason: "could not read the registry: HTTP request failed", unread: true },
    ]);

    expect(report.status).toBe("revoked");
    expect(report.forgetLocal).toBe(true);
    expect(report.notRevokedOn).toEqual([]);
    expect(report.notChecked.map((l) => l.chainId)).toEqual([8453, 1]);
    expect(report.note).toContain("Chain 8453, 1 could not be read");
  });

  test("another chain holding the key whose revoke failed keeps the local session", () => {
    const report = revokeReport([
      confirmed(56),
      { chainId: 1, kind: "account", status: "FAILED", reason: "relay status FAILED (code 300)" },
    ]);

    expect(report.status).toBe("failed");
    expect(report.forgetLocal).toBe(false);
    expect(report.notRevokedOn).toEqual([{ chainId: 1, kind: "account", reason: "relay status FAILED (code 300)" }]);
    expect(report.note).toContain("not on chain 1");
  });

  test("a failed revoke elsewhere wins over an unreadable chain", () => {
    const report = revokeReport([
      confirmed(56),
      { chainId: 1, kind: "account", status: "FAILED", reason: "reverted" },
      { chainId: 8453, kind: "account", status: "FAILED", reason: "could not read the account's keys: x", unread: true },
    ]);

    expect(report.status).toBe("failed");
    expect(report.forgetLocal).toBe(false);
    expect(report.notChecked.map((l) => l.chainId)).toEqual([8453]);
  });
});

describe("revokeFailureText", () => {
  test("says the session was kept and how each chain went", () => {
    const text = revokeFailureText({
      sessionName: "bot",
      networkName: "BNB Smart Chain",
      reason: "Session revoke did not confirm on chain 56 (account leg on chain 56: status=FAILED (relay code 300)).",
      legs: [
        { chainId: 56, kind: "account", status: "FAILED", reason: "relay status FAILED (code 300)" },
        confirmed(1),
      ],
    });

    expect(text).toContain('session "bot" did not go through on BNB Smart Chain');
    expect(text).toContain("were kept");
    expect(text).toContain("- account on chain 56: FAILED (relay status FAILED (code 300))");
    expect(text).toContain("- account on chain 1: CONFIRMED");
  });
});
