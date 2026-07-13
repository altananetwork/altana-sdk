/**
 * Fork test: prove an x402 EIP-3009 payment settles from an Altana session key
 * against a REAL FiatTokenV2_2 USDC on a Base fork.
 *
 * This is the on-chain oracle for the EIP-3009 rail: the account's ERC-1271
 * `isValidSignature` must actually be invoked and accepted by Circle's
 * SignatureChecker path for a session-key (contract) signer — something no unit
 * test can prove.
 *
 * Flow: delegate a fresh EOA to IthacaAccount on a Base fork, deal it USDC,
 * authorize a session key, approve the USDC token as the signature checker (for
 * EIP-3009 the token itself calls isValidSignature), sign a
 * `TransferWithAuthorization` with the SDK (signOrderTypedData /
 * buildEip3009TypedData), then have a "facilitator" EOA call the real
 * `USDC.transferWithAuthorization(...bytes signature)` and assert the recipient
 * received the funds.
 *
 * Run: bun tests/e2e/fork-eip3009.ts
 */

import {
  createTestClient,
  createWalletClient,
  createPublicClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toHex,
  concatHex,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createPrivateKeySigner,
  signOrderTypedData,
  buildEip3009TypedData,
} from "@altananetwork/sdk";
import type { Session } from "@altananetwork/sdk";

const ITHACA_ACCOUNT_IMPL: Address =
  "0x4B5d20CD8a3927B500540d9BcCDDc27385c9fA79"; // same CREATE2 address on BNB/Base/Eth
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base USDC, FiatTokenV2_2 (6 dec)
const USDC_NAME = "USD Coin";
const USDC_VERSION = "2";
const BASE_CHAIN_ID = 8453;
const BASE_RPC = "https://base-rpc.publicnode.com";
const ANVIL_PORT = 8548;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

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
] as const;

// FiatTokenV2_2 EIP-3009 with a bytes signature (the ERC-1271-capable overload).
const EIP3009_ABI = [
  {
    name: "transferWithAuthorization",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

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
  console.log(`Forking Base via anvil on ${ANVIL_URL} ...`);
  const proc = Bun.spawn(
    ["anvil", "--fork-url", BASE_RPC, "--port", String(ANVIL_PORT), "--silent"],
    { stdout: "ignore", stderr: "ignore" },
  );

  try {
    await waitForAnvil();
    const test = createTestClient({
      mode: "anvil",
      chain: base,
      transport: http(ANVIL_URL),
    });
    const publicClient = createPublicClient({
      chain: base,
      transport: http(ANVIL_URL),
    });

    // Sanity: the IthacaAccount impl really is deployed on Base at this address.
    const implCode = await publicClient.getCode({ address: ITHACA_ACCOUNT_IMPL });
    assert(!!implCode && implCode !== "0x", "IthacaAccount impl has code on Base");

    // Account EOA delegated to IthacaAccount (EIP-7702).
    const accountSigner = createPrivateKeySigner();
    const account = accountSigner.address;
    await test.setBalance({ address: account, value: 10n ** 18n });
    await test.setCode({
      address: account,
      bytecode: concatHex(["0xef0100", ITHACA_ACCOUNT_IMPL]),
    });

    // Deal USDC (6 dec) to the account by locating its balances slot.
    const amount = 10_000n; // 0.01 USDC
    const dealAmount = amount * 100n;
    const balSlot = await dealToken(test, publicClient, USDC, account, dealAmount);
    const startBal = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    });
    assert(startBal === dealAmount, `dealt USDC (slot ${balSlot}); got ${startBal}`);

    // Session key + on-chain keyHash (secp256k1 = keyType 2, publicKey = abi.encode(address)).
    const sessionSigner = createPrivateKeySigner();
    const session: Session = {
      walletAddress: account,
      signer: sessionSigner,
      publicKey: sessionSigner.publicKey,
      permissions: {},
      expiry: 0,
    };
    const sessionPubKeyEncoded = encodeAbiParameters(
      [{ type: "address" }],
      [sessionSigner.address],
    );
    const keyHash = keccak256(
      encodeAbiParameters(
        [{ type: "uint256" }, { type: "bytes32" }],
        [2n, keccak256(sessionPubKeyEncoded)],
      ),
    );

    // As the account: authorize the session key, then approve the USDC TOKEN as
    // the signature checker (for EIP-3009 the token calls isValidSignature).
    await test.impersonateAccount({ address: account });
    const asAccount = createWalletClient({
      account,
      chain: base,
      transport: http(ANVIL_URL),
    });
    const sends: { to: Address; data: Hex }[] = [
      {
        to: account,
        data: encodeFunctionData({
          abi: ACCOUNT_ABI,
          functionName: "authorize",
          args: [
            { expiry: 0, keyType: 2, isSuperAdmin: false, publicKey: sessionPubKeyEncoded },
          ],
        }),
      },
      {
        to: account,
        data: encodeFunctionData({
          abi: ACCOUNT_ABI,
          functionName: "setSignatureCheckerApproval",
          args: [keyHash, USDC, true],
        }),
      },
    ];
    for (const s of sends) {
      const hash = await asAccount.sendTransaction(s);
      await publicClient.waitForTransactionReceipt({ hash });
    }
    await test.stopImpersonatingAccount({ address: account });

    // Facilitator EOA (submits the transferWithAuthorization) + recipient.
    const facilitator = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: facilitator.address, value: 10n ** 18n });
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const recipientBefore = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [recipient],
    });

    // Sign the EIP-3009 TransferWithAuthorization with the session key.
    const validAfter = 0n;
    const validBefore = 2_000_000_000n;
    const nonce: Hex =
      "0x00000000000000000000000000000000000000000000000000000000000000a1";
    const signature = await signOrderTypedData(
      session,
      buildEip3009TypedData({
        chainId: BASE_CHAIN_ID,
        token: USDC,
        name: USDC_NAME,
        version: USDC_VERSION,
        from: account,
        to: recipient,
        value: amount,
        validAfter,
        validBefore,
        nonce,
      }) as any,
    );

    // Facilitator settles via the REAL USDC.transferWithAuthorization (bytes sig).
    const facilitatorClient = createWalletClient({
      account: facilitator,
      chain: base,
      transport: http(ANVIL_URL),
    });
    const settleHash = await facilitatorClient.sendTransaction({
      to: USDC,
      data: encodeFunctionData({
        abi: EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [account, recipient, amount, validAfter, validBefore, nonce, signature],
      }),
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: settleHash,
    });
    assert(receipt.status === "success", "transferWithAuthorization settled");

    const recipientAfter = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [recipient],
    });
    const accountAfter = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    });
    assert(
      recipientAfter - recipientBefore === amount,
      `recipient received exactly the payment (delta ${recipientAfter - recipientBefore})`,
    );
    assert(
      startBal - accountAfter === amount,
      `payer was debited exactly the payment (delta ${startBal - accountAfter})`,
    );

    console.log(
      `Result: PASS ✓ (EIP-3009 settled ${amount} from a session-key ERC-1271 signature)`,
    );
  } finally {
    proc.kill();
  }
}

/**
 * Find the ERC20 balances mapping slot by probing, and set `holder`'s balance.
 * The viem clients are typed loosely: Base is an OP-stack chain whose Block type
 * doesn't unify with the argless client return types, and this helper only needs
 * setStorageAt / readContract.
 */
async function dealToken(
  test: any,
  publicClient: any,
  token: Address,
  holder: Address,
  amount: bigint,
): Promise<number> {
  for (let slot = 0; slot < 30; slot++) {
    const key = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }],
        [holder, BigInt(slot)],
      ),
    );
    await test.setStorageAt({
      address: token,
      index: key,
      value: pad(toHex(amount)),
    });
    const bal = await publicClient.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [holder],
    });
    if (bal === amount) return slot;
    await test.setStorageAt({ address: token, index: key, value: pad("0x0") });
  }
  throw new Error("could not locate the token balances slot");
}

main().catch((e) => {
  console.error("Result: FAIL ✗");
  console.error(e);
  process.exit(1);
});
