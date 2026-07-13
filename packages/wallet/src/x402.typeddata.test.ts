import { test, expect } from "bun:test";
import {
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  PERMIT2_ADDRESS,
  buildPermit2TypedData,
  buildEip3009TypedData,
} from "./x402.js";

const TOKEN: Address = "0x55d398326f99059fF775485246999027B3197955"; // BSC-USDT
const SPENDER: Address = "0x1234567890123456789012345678901234567890";
const FROM: Address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TO: Address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// Independent oracle: reproduce Permit2's on-chain digest (SignatureTransfer +
// PermitHash) by hand, then require the builder to match.
function permit2DigestOracle(a: {
  chainId: number;
  token: Address;
  amount: bigint;
  spender: Address;
  nonce: bigint;
  deadline: bigint;
}): Hex {
  const TOKEN_PERMISSIONS_TYPEHASH = keccak256(
    toHex("TokenPermissions(address token,uint256 amount)"),
  );
  const PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
    toHex(
      "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)",
    ),
  );
  const tokenPermissions = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [TOKEN_PERMISSIONS_TYPEHASH, a.token, a.amount],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        PERMIT_TRANSFER_FROM_TYPEHASH,
        tokenPermissions,
        a.spender,
        a.nonce,
        a.deadline,
      ],
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        keccak256(
          toHex("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
        ),
        keccak256(toHex("Permit2")),
        BigInt(a.chainId),
        PERMIT2_ADDRESS,
      ],
    ),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

function eip3009DigestOracle(a: {
  chainId: number;
  token: Address;
  name: string;
  version: string;
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
}): Hex {
  const TYPEHASH = keccak256(
    toHex(
      "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [TYPEHASH, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce],
    ),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        keccak256(
          toHex(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
          ),
        ),
        keccak256(toHex(a.name)),
        keccak256(toHex(a.version)),
        BigInt(a.chainId),
        a.token,
      ],
    ),
  );
  return keccak256(concatHex(["0x1901", domainSeparator, structHash]));
}

test("buildPermit2TypedData matches Permit2's on-chain digest", () => {
  const input = {
    chainId: 56,
    token: TOKEN,
    amount: 10_000n,
    spender: SPENDER,
    nonce: 42n,
    deadline: 1_800_000_000n,
  };
  expect(hashTypedData(buildPermit2TypedData(input) as any)).toBe(
    permit2DigestOracle(input),
  );
});

test("buildEip3009TypedData matches the token's on-chain digest", () => {
  const input = {
    chainId: 56,
    token: TOKEN,
    name: "USD Coin",
    version: "2",
    from: FROM,
    to: TO,
    value: 10_000n,
    validAfter: 0n,
    validBefore: 1_800_000_000n,
    nonce: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex,
  };
  expect(hashTypedData(buildEip3009TypedData(input) as any)).toBe(
    eip3009DigestOracle(input),
  );
});
