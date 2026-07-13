/**
 * Fork test: prove that a session key's signOrder signature is accepted by the
 * REAL IthacaAccount `isValidSignature` on an anvil mainnet fork — but only when
 * the caller (msg.sender) is an approved checker.
 *
 * No relay, no real funds. We fork BNB, delegate a fresh EOA (EIP-7702) directly
 * to the deployed IthacaAccount implementation, impersonate it to authorize a
 * session key + approve a checker, then eth_call isValidSignature with our
 * TS-produced wrapped signature.
 *
 * Run: bun tests/e2e/fork-erc1271.ts
 */

import {
  createTestClient,
  createWalletClient,
  createPublicClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
  concatHex,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import {
  createPrivateKeySigner,
  createHeadlessPasskey,
  signOrder,
} from "@altananetwork/sdk";
import type { Session, Signer } from "@altananetwork/sdk";

// Deterministic CREATE2 deploy address, identical on every chain
// (altana-account-mainnet/deploy/config.toml).
const ITHACA_ACCOUNT_IMPL: Address =
  "0x4B5d20CD8a3927B500540d9BcCDDc27385c9fA79";
const BSC_RPC = "https://bsc-rpc.publicnode.com";
const ANVIL_PORT = 8546;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const ACCOUNT_ABI = [
  {
    name: "authorize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "keyHash", type: "bytes32" }],
  },
  {
    name: "setSignatureCheckerApproval",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "checker", type: "address" },
      { name: "isApproved", type: "bool" },
    ],
    outputs: [],
  },
  {
    name: "isValidSignature",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "digest", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ type: "bytes4" }],
  },
] as const;

const ERC1271_MAGIC = "0x1626ba7e";
const ERC1271_FAIL = "0xffffffff";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function waitForAnvil(): Promise<void> {
  const probe = createPublicClient({ transport: http(ANVIL_URL) });
  for (let i = 0; i < 60; i++) {
    try {
      await probe.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("anvil did not become ready");
}

async function main() {
  console.log(`Forking BNB via anvil on ${ANVIL_URL} ...`);
  const proc = Bun.spawn(
    [
      "anvil",
      "--fork-url",
      BSC_RPC,
      "--port",
      String(ANVIL_PORT),
      "--silent",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );

  try {
    await waitForAnvil();

    const test = createTestClient({
      mode: "anvil",
      chain: bsc,
      transport: http(ANVIL_URL),
    });
    const publicClient = createPublicClient({
      chain: bsc,
      transport: http(ANVIL_URL),
    });

    // Sanity: the impl is really deployed on this chain.
    const implCode = await publicClient.getBytecode({
      address: ITHACA_ACCOUNT_IMPL,
    });
    assert(!!implCode && implCode !== "0x", "IthacaAccount impl has code on BNB");

    // Fresh account EOA — delegate it (EIP-7702) directly to the impl.
    const accountSigner = createPrivateKeySigner();
    const account = accountSigner.address;
    await test.setBalance({ address: account, value: 10n ** 20n });
    await test.setCode({
      address: account,
      bytecode: concatHex(["0xef0100", ITHACA_ACCOUNT_IMPL]),
    });
    const acctCode = await publicClient.getBytecode({ address: account });
    assert(
      acctCode === concatHex(["0xef0100", ITHACA_ACCOUNT_IMPL]).toLowerCase(),
      "account EOA delegates to the impl",
    );

    // Impersonate the account to authorize keys + approve checkers.
    await test.impersonateAccount({ address: account });
    const asAccount = createWalletClient({
      account,
      chain: bsc,
      transport: http(ANVIL_URL),
    });
    const checker: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3"; // stand-in verifier
    const stranger: Address = "0xdead000000000000000000000000000000000001";
    const appDigest: Hex =
      "0x9999999999999999999999999999999999999999999999999999999999999999";

    const makeSession = (signer: Signer): Session => ({
      walletAddress: account,
      signer,
      publicKey: signer.publicKey,
      permissions: {},
      expiry: 0,
    });

    async function verifyCase(
      label: string,
      keyType: number,
      publicKeyEncoded: Hex,
      session: Session,
    ) {
      const keyHash = keccak256(
        encodeAbiParameters(
          [{ type: "uint256" }, { type: "bytes32" }],
          [BigInt(keyType), keccak256(publicKeyEncoded)],
        ),
      );
      const authTx = await asAccount.sendTransaction({
        to: account,
        data: encodeFunctionData({
          abi: ACCOUNT_ABI,
          functionName: "authorize",
          args: [
            { expiry: 0, keyType, isSuperAdmin: false, publicKey: publicKeyEncoded },
          ],
        }),
      });
      await publicClient.waitForTransactionReceipt({ hash: authTx });
      const approveTx = await asAccount.sendTransaction({
        to: account,
        data: encodeFunctionData({
          abi: ACCOUNT_ABI,
          functionName: "setSignatureCheckerApproval",
          args: [keyHash, checker, true],
        }),
      });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });

      const wrapped = await signOrder(session, appDigest);
      const fromChecker = await publicClient.readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "isValidSignature",
        args: [appDigest, wrapped],
        account: checker,
      });
      assert(
        fromChecker === ERC1271_MAGIC,
        `${label}: isValidSignature from checker → magic (got ${fromChecker})`,
      );
      const fromStranger = await publicClient.readContract({
        address: account,
        abi: ACCOUNT_ABI,
        functionName: "isValidSignature",
        args: [appDigest, wrapped],
        account: stranger,
      });
      assert(
        fromStranger === ERC1271_FAIL,
        `${label}: isValidSignature from stranger → invalid (got ${fromStranger})`,
      );
      console.log(`  ${label}: checker→magic, stranger→invalid ✓`);
    }

    // secp256k1 session key (publicKey stored as abi.encode(address)).
    const s1 = createPrivateKeySigner();
    await verifyCase(
      "secp256k1",
      2,
      encodeAbiParameters([{ type: "address" }], [s1.address]),
      makeSession(s1),
    );

    // passkey (WebAuthnP256) session key (publicKey stored as flat x||y).
    const pk = createHeadlessPasskey();
    await verifyCase("webauthn-p256", 1, pk.publicKey, makeSession(pk));

    await test.stopImpersonatingAccount({ address: account });
    console.log("Result: PASS ✓");
  } finally {
    proc.kill();
  }
}

main().catch((e) => {
  console.error("Result: FAIL ✗");
  console.error(e);
  process.exit(1);
});
