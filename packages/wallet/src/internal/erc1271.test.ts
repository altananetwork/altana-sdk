import { test, expect } from "bun:test";
import {
  concatHex,
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { erc1271Digest } from "./erc1271.js";

// Independent oracle: hand-roll the nested EIP-712 digest exactly as the
// account does (IthacaAccount.sol:234-283, cross-checked against the Solidity
// test Account.t.sol:94-104). erc1271Digest must equal this.
function handRolledDigest(wallet: Address, appDigest: Hex): Hex {
  const SIGN_TYPEHASH = keccak256(toHex("ERC1271Sign(bytes32 digest)"));
  const DOMAIN_TYPEHASH = keccak256(
    toHex("EIP712Domain(address verifyingContract)"),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [SIGN_TYPEHASH, appDigest],
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }],
      [DOMAIN_TYPEHASH, wallet],
    ),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

test("erc1271Digest matches the account's nested EIP-712 construction", () => {
  const wallet: Address = "0x1111111111111111111111111111111111111111";
  const appDigest: Hex =
    "0x2222222222222222222222222222222222222222222222222222222222222222";

  expect(erc1271Digest(wallet, appDigest)).toBe(
    handRolledDigest(wallet, appDigest),
  );
});

test("erc1271Digest is domain-separated by wallet address", () => {
  const appDigest: Hex =
    "0x3333333333333333333333333333333333333333333333333333333333333333";
  const a = erc1271Digest(
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    appDigest,
  );
  const b = erc1271Digest(
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    appDigest,
  );
  expect(a).not.toBe(b);
});
