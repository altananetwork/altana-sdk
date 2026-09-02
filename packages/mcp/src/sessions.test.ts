/**
 * StoredSession must remain a structural superset of the SDK's
 * SerializedSession, so the keychain-backed restore path stays cast-free:
 * deserializeSession(stored, signer) — see index.ts's session tools.
 */
import { describe, expect, test } from "bun:test";
import { deserializeSession, createPrivateKeySigner } from "@altananetwork/sdk";
import type { StoredSession } from "./sessions.js";

describe("StoredSession interop", () => {
  test("a StoredSession literal deserializes without casts", () => {
    const signer = createPrivateKeySigner();
    const stored: StoredSession = {
      name: "agent-1",
      walletName: "main",
      walletAddress: "0x1111111111111111111111111111111111111111",
      publicKey: signer.publicKey,
      permissions: {
        calls: [{ to: "0x2222222222222222222222222222222222222222", signature: "transfer(address,uint256)" }],
        spend: [{ limit: "50000000000000000000", period: "day" }],
      },
      expiry: 1_900_000_000,
      createdAt: new Date().toISOString(),
    };
    const session = deserializeSession(stored, signer);
    expect(session.permissions.spend?.[0]?.limit).toBe(50000000000000000000n);
    expect(session.signer).toBe(signer);
  });
});
