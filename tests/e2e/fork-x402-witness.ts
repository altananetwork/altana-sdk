/**
 * Fork test: prove a B402 `permit2-exact` payment settles from an Altana session
 * key against REAL Permit2 on a BNB fork — using the recipient-binding WITNESS
 * (`permitWitnessTransferFrom`), the actual rail Binance's x402ExactPermit2Proxy
 * verifies.
 *
 * This codifies the read-only simulation done during investigation as an
 * executing, asserting test: sign `buildPermit2WitnessTypedData(...)` with the
 * session key, then have a "facilitator" EOA (bound as `spender`) call the real
 * `Permit2.permitWitnessTransferFrom(...)` and assert the merchant (witness.to)
 * received exactly the payment.
 *
 * Run: bun tests/e2e/fork-x402-witness.ts
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
import { bsc } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createPrivateKeySigner,
  signOrderTypedData,
  buildPermit2WitnessTypedData,
  PERMIT2_ADDRESS,
} from "@altananetwork/sdk";
import type { Session } from "@altananetwork/sdk";

const ITHACA_ACCOUNT_IMPL: Address =
  "0x4B5d20CD8a3927B500540d9BcCDDc27385c9fA79";
const USDC: Address = "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"; // Binance-Peg USDC (18 dec)
const BSC_RPC = process.env.BSC_FORK_RPC_URL ?? "https://bsc-rpc.publicnode.com";
const ANVIL_PORT = 8549;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

// The witness type string is exactly what the x402ExactPermit2Proxy embeds and
// what Permit2 hashes into the PermitWitnessTransferFrom typehash.
const WITNESS_TYPE_STRING =
  "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)";
const WITNESS_TYPEHASH = keccak256(
  toHex("Witness(address to,uint256 validAfter)"),
);

const ERC20_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
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

const PERMIT2_WITNESS_ABI = [
  {
    name: "permitWitnessTransferFrom",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        components: [
          {
            name: "permitted",
            type: "tuple",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        name: "transferDetails",
        type: "tuple",
        components: [
          { name: "to", type: "address" },
          { name: "requestedAmount", type: "uint256" },
        ],
      },
      { name: "owner", type: "address" },
      { name: "witness", type: "bytes32" },
      { name: "witnessTypeString", type: "string" },
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
  console.log(`Forking BNB via anvil on ${ANVIL_URL} ...`);
  const proc = Bun.spawn(
    ["anvil", "--fork-url", BSC_RPC, "--port", String(ANVIL_PORT), "--silent"],
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

    // Account EOA delegated to IthacaAccount.
    const accountSigner = createPrivateKeySigner();
    const account = accountSigner.address;
    await test.setBalance({ address: account, value: 10n ** 20n });
    await test.setCode({
      address: account,
      bytecode: concatHex(["0xef0100", ITHACA_ACCOUNT_IMPL]),
    });

    // Deal USDC to the account.
    const amount = 10_000_000_000_000_000n; // 0.01 USDC (18 dec)
    const dealAmount = amount * 100n;
    const balSlot = await dealToken(test, publicClient, USDC, account, dealAmount);
    const startBal = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    });
    assert(startBal === dealAmount, `dealt USDC (slot ${balSlot}); got ${startBal}`);

    // Session key + on-chain keyHash.
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

    // As the account: approve Permit2, authorize the session key, approve Permit2
    // as the signature checker.
    await test.impersonateAccount({ address: account });
    const asAccount = createWalletClient({
      account,
      chain: bsc,
      transport: http(ANVIL_URL),
    });
    const sends: { to: Address; data: Hex }[] = [
      {
        to: USDC,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [PERMIT2_ADDRESS, 2n ** 256n - 1n],
        }),
      },
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
          args: [keyHash, PERMIT2_ADDRESS, true],
        }),
      },
    ];
    for (const s of sends) {
      const hash = await asAccount.sendTransaction(s);
      await publicClient.waitForTransactionReceipt({ hash });
    }
    await test.stopImpersonatingAccount({ address: account });

    // Facilitator EOA (bound as the Permit2 `spender`) + merchant recipient (witness.to).
    const facilitator = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: facilitator.address, value: 10n ** 20n });
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const recipientBefore = await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [recipient],
    });

    // Sign the Permit2 PermitWitnessTransferFrom with the session key. `spender`
    // = the facilitator (the permitWitnessTransferFrom caller); witness binds the
    // recipient (to = payTo, validAfter = 0), exactly as B402 requires.
    const nonce = 7n;
    const deadline = 2_000_000_000n;
    const validAfter = 0n;
    const signature = await signOrderTypedData(
      session,
      buildPermit2WitnessTypedData({
        chainId: 56,
        token: USDC,
        amount,
        spender: facilitator.address,
        nonce,
        deadline,
        to: recipient,
        validAfter,
      }) as any,
    );

    // The witness struct hash the proxy/facilitator passes to Permit2.
    const witnessHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
        [WITNESS_TYPEHASH, recipient, validAfter],
      ),
    );

    // Facilitator settles via the REAL Permit2.permitWitnessTransferFrom.
    const facilitatorClient = createWalletClient({
      account: facilitator,
      chain: bsc,
      transport: http(ANVIL_URL),
    });
    const settleHash = await facilitatorClient.sendTransaction({
      to: PERMIT2_ADDRESS,
      data: encodeFunctionData({
        abi: PERMIT2_WITNESS_ABI,
        functionName: "permitWitnessTransferFrom",
        args: [
          { permitted: { token: USDC, amount }, nonce, deadline },
          { to: recipient, requestedAmount: amount },
          account,
          witnessHash,
          WITNESS_TYPE_STRING,
          signature,
        ],
      }),
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: settleHash,
    });
    assert(receipt.status === "success", "permitWitnessTransferFrom settled");

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
      `merchant (witness.to) received exactly the payment (delta ${recipientAfter - recipientBefore})`,
    );
    assert(
      startBal - accountAfter === amount,
      `payer was debited exactly the payment (delta ${startBal - accountAfter})`,
    );

    console.log(
      `Result: PASS ✓ (Permit2 permitWitnessTransferFrom settled ${amount} from a session-key signature)`,
    );
  } finally {
    proc.kill();
  }
}

/** Find the ERC20 balances mapping slot by probing, and set `holder`'s balance. */
async function dealToken(
  test: ReturnType<typeof createTestClient>,
  publicClient: ReturnType<typeof createPublicClient>,
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
