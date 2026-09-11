/**
 * grant_session's calls rule: the three mutually exclusive ways to scope a
 * session, and that the `erc8004-identity` preset is exactly the SDK's
 * selector-scoped set (never a registry-wide grant).
 */
import { describe, expect, test } from "bun:test";
import { toFunctionSelector, type Address } from "viem";
import { erc8004RegisterPermissions, erc8183Addresses, erc8183SubmitPermissions } from "@altananetwork/sdk";
import { buildGrantCalls } from "./scopes.js";

const CHAIN = 97;
const RECIPIENT = "0x00000000000000000000000000000000000000a1" as Address;
const REGISTRY = erc8183Addresses(CHAIN).registry;

describe("buildGrantCalls", () => {
  test("recipient alone: one target, any selector (the original shape)", () => {
    expect(buildGrantCalls({ chainId: CHAIN, recipient: RECIPIENT })).toEqual([{ to: RECIPIENT }]);
    expect(buildGrantCalls({ chainId: CHAIN, recipient: RECIPIENT, signatures: [] })).toEqual([{ to: RECIPIENT }]);
  });

  test("recipient + signatures: one entry per function, all at that target", () => {
    expect(
      buildGrantCalls({
        chainId: CHAIN,
        recipient: RECIPIENT,
        signatures: ["transfer(address,uint256)", "0xa9059cbb"],
      }),
    ).toEqual([
      { to: RECIPIENT, signature: "transfer(address,uint256)" },
      { to: RECIPIENT, signature: "0xa9059cbb" },
    ]);
  });

  test("scope erc8004-identity is the SDK's selector-scoped set, with no target-only entry", () => {
    const calls = buildGrantCalls({ chainId: CHAIN, scope: "erc8004-identity" });
    expect(calls).toEqual(erc8004RegisterPermissions(CHAIN) as typeof calls);
    expect(calls.every((c) => c.to === REGISTRY && typeof c.signature === "string")).toBe(true);
    expect(calls.map((c) => toFunctionSelector(c.signature!))).toEqual([
      toFunctionSelector("register(string,(string,bytes)[])"),
      toFunctionSelector("setAgentURI(uint256,string)"),
    ]);
  });

  test("scope erc8183-seller is exactly submit on the commerce kernel", () => {
    const calls = buildGrantCalls({ chainId: CHAIN, scope: "erc8183-seller" });
    expect(calls).toEqual([...erc8183SubmitPermissions(CHAIN)]);
    expect(calls).toEqual([{ to: erc8183Addresses(CHAIN).commerce, signature: "submit(uint256,bytes32,bytes)" }]);
  });

  test("scope and recipient are mutually exclusive", () => {
    expect(() => buildGrantCalls({ chainId: CHAIN, scope: "erc8004-identity", recipient: RECIPIENT })).toThrow(
      /either `scope` or `recipient`/,
    );
  });

  test("one of scope or recipient is required", () => {
    expect(() => buildGrantCalls({ chainId: CHAIN })).toThrow(/pass `scope`.*or `recipient`/);
  });

  test("signatures cannot ride on a scope", () => {
    expect(() =>
      buildGrantCalls({ chainId: CHAIN, scope: "erc8004-identity", signatures: ["register(string)"] }),
    ).toThrow(/cannot be combined with `scope`/);
  });

  test("rejects a signature that is neither a function signature nor a selector", () => {
    expect(() => buildGrantCalls({ chainId: CHAIN, recipient: RECIPIENT, signatures: ["transfer"] })).toThrow(
      /"transfer" is not a function signature/,
    );
    expect(() => buildGrantCalls({ chainId: CHAIN, recipient: RECIPIENT, signatures: ["0xa9059c"] })).toThrow(
      /not a function signature/,
    );
  });
});
