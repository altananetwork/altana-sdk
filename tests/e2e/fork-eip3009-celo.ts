/**
 * Fork test: does Celo's USDC honour an ERC-1271 (contract) signature on the
 * EIP-3009 rail, and if so what actually caused our live 500?
 *
 * This exists because `2026-09-29-x402-celo-facilitator.md` §3 concluded, from
 * a single revert string and no control, that "Celo Sepolia's USDC checks its
 * EIP-3009 signature with ecrecover and knows nothing about ERC-1271". infra
 * re-tested the token with a control and found the opposite. This script is the
 * same question asked in our own area, with the control that was missing: the
 * REAL IthacaAccount, a REAL session key, and the only variable being whether
 * the account was told to accept the token as a signature checker.
 *
 *   A (control)  no checker approval  -> expect "FiatTokenV2: invalid signature"
 *   B            token approved       -> expect the transfer to settle
 *
 * A is the configuration our live run was in. If A reproduces the live revert
 * and B settles, the token was never the blocker and the missing approval was,
 * which is precisely what PR #109's `x402Tokens` grant option sets.
 *
 * Celo Sepolia's IthacaAccount lives at a DIFFERENT address from Base/BNB/Eth
 * (0x4f4dde38…, read from the delegation of a wallet we provisioned there).
 *
 * Run: bun tests/e2e/fork-eip3009-celo.ts
 */

import {
  createTestClient,
  createWalletClient,
  createPublicClient,
  defineChain,
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
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  createPrivateKeySigner,
  signOrderTypedData,
  buildEip3009TypedData,
} from "@altananetwork/sdk";
import type { Session } from "@altananetwork/sdk";

// Read from the delegation of 0x957550A7…, provisioned on Celo Sepolia for the
// PR #109 live proof. Not the 0x4B5d20CD… address the other chains share.
const ITHACA_ACCOUNT_IMPL: Address =
  "0x4f4DdE38dA9F8abbB96c48ca520b992d4bADc3d6";
const USDC: Address = "0x01C5C0122039549AD1493B8220cABEdD739BC44E";
// The token's own EIP-712 domain, read on chain: name() is "USDC" here, where
// Base's is "USD Coin". Our x402-server registry already carries this.
const USDC_NAME = "USDC";
const USDC_VERSION = "2";
const CHAIN_ID = 11142220;
const FORK_RPC =
  process.env.CELO_SEPOLIA_FORK_RPC_URL ??
  "https://forno.celo-sepolia.celo-testnet.org";
const ANVIL_PORT = 8549;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const CHAIN = defineChain({
  id: CHAIN_ID,
  name: "Celo Sepolia (fork)",
  nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
});

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
  {
    name: "approvedSignatureCheckers",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "keyHash", type: "bytes32" }],
    outputs: [{ type: "address[]" }],
  },
] as const;

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
  console.log(`  ok: ${msg}`);
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
  console.log(`Forking Celo Sepolia via anvil on ${ANVIL_URL} ...`);
  const proc = Bun.spawn(
    ["anvil", "--fork-url", FORK_RPC, "--port", String(ANVIL_PORT), "--silent"],
    { stdout: "ignore", stderr: "ignore" },
  );

  try {
    await waitForAnvil();
    const test = createTestClient({
      mode: "anvil",
      chain: CHAIN,
      transport: http(ANVIL_URL),
    });
    const publicClient = createPublicClient({
      chain: CHAIN,
      transport: http(ANVIL_URL),
    });

    const implCode = await publicClient.getCode({ address: ITHACA_ACCOUNT_IMPL });
    assert(
      !!implCode && implCode !== "0x",
      `IthacaAccount impl has code on Celo Sepolia at ${ITHACA_ACCOUNT_IMPL}`,
    );

    // A fresh EOA delegated to IthacaAccount (EIP-7702), as the relay does.
    const accountSigner = createPrivateKeySigner();
    const account = accountSigner.address;
    await test.setBalance({ address: account, value: 10n ** 18n });
    await test.setCode({
      address: account,
      bytecode: concatHex(["0xef0100", ITHACA_ACCOUNT_IMPL]),
    });

    const amount = 10_000n; // 0.01 USDC
    const dealAmount = amount * 100n;
    const balSlot = await dealToken(test, publicClient, USDC, account, dealAmount);
    const startBal = (await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    assert(startBal === dealAmount, `dealt USDC (slot ${balSlot}); got ${startBal}`);

    // Session key: NOT super-admin, which is the whole point — a super-admin
    // key passes ERC-1271 from any caller and would hide the effect.
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

    await test.impersonateAccount({ address: account });
    const asAccount = createWalletClient({
      account,
      chain: CHAIN,
      transport: http(ANVIL_URL),
    });
    const authHash = await asAccount.sendTransaction({
      to: account,
      data: encodeFunctionData({
        abi: ACCOUNT_ABI,
        functionName: "authorize",
        args: [
          { expiry: 0, keyType: 2, isSuperAdmin: false, publicKey: sessionPubKeyEncoded },
        ],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: authHash });

    const checkersBefore = (await publicClient.readContract({
      address: account,
      abi: ACCOUNT_ABI,
      functionName: "approvedSignatureCheckers",
      args: [keyHash],
    })) as readonly Address[];
    assert(
      checkersBefore.length === 0,
      `part A starts with an EMPTY checker set (what the live run had)`,
    );

    // Facilitator EOA + recipient.
    const facilitator = privateKeyToAccount(generatePrivateKey());
    await test.setBalance({ address: facilitator.address, value: 10n ** 18n });
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const facilitatorClient = createWalletClient({
      account: facilitator,
      chain: CHAIN,
      transport: http(ANVIL_URL),
    });

    // ONE signature, used for both halves. EIP-3009 nonces are only consumed by
    // a successful transfer, so the rejected attempt leaves it spendable.
    const validAfter = 0n;
    const validBefore = 2_000_000_000n;
    const nonce: Hex =
      "0x00000000000000000000000000000000000000000000000000000000000000a1";
    const signature = await signOrderTypedData(
      session,
      buildEip3009TypedData({
        chainId: CHAIN_ID,
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
    const settleCall = {
      to: USDC,
      data: encodeFunctionData({
        abi: EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args: [account, recipient, amount, validAfter, validBefore, nonce, signature],
      }),
    } as const;

    // ---- A: no checker approval. The live configuration. ----
    console.log("\n[A] no checker approval (reproducing the live run)");
    let aError = "";
    try {
      const h = await facilitatorClient.sendTransaction(settleCall);
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      aError = r.status === "success" ? "" : "reverted without a reason string";
    } catch (e) {
      aError = e instanceof Error ? e.message : String(e);
    }
    assert(aError !== "", "part A is refused on chain");
    assert(
      /FiatTokenV2: invalid signature/.test(aError),
      `part A reverts with the SAME string as the live 500: "FiatTokenV2: invalid signature"`,
    );

    // ---- B: approve the token as the checker, change nothing else. ----
    console.log("\n[B] approve the token as this key's signature checker");
    const apprHash = await asAccount.sendTransaction({
      to: account,
      data: encodeFunctionData({
        abi: ACCOUNT_ABI,
        functionName: "setSignatureCheckerApproval",
        args: [keyHash, USDC, true],
      }),
    });
    await publicClient.waitForTransactionReceipt({ hash: apprHash });
    await test.stopImpersonatingAccount({ address: account });
    const checkersAfter = (await publicClient.readContract({
      address: account,
      abi: ACCOUNT_ABI,
      functionName: "approvedSignatureCheckers",
      args: [keyHash],
    })) as readonly Address[];
    assert(
      checkersAfter.length === 1 &&
        checkersAfter[0]!.toLowerCase() === USDC.toLowerCase(),
      `the token is now the key's only approved checker`,
    );

    const recipientBefore = (await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [recipient],
    })) as bigint;
    const settleHash = await facilitatorClient.sendTransaction(settleCall);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: settleHash,
    });
    assert(
      receipt.status === "success",
      "part B settles the SAME signature that part A refused",
    );

    const recipientAfter = (await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [recipient],
    })) as bigint;
    const accountAfter = (await publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account],
    })) as bigint;
    assert(
      recipientAfter - recipientBefore === amount,
      `recipient received exactly the payment (delta ${recipientAfter - recipientBefore})`,
    );
    assert(
      startBal - accountAfter === amount,
      `payer was debited exactly the payment (delta ${startBal - accountAfter})`,
    );

    console.log(
      "\nResult: PASS ✓ Celo USDC DOES honour ERC-1271 on EIP-3009.\n" +
        "  The only variable between the refusal and the settlement was the\n" +
        "  account's checker approval, so the token was never the blocker.",
    );
  } finally {
    proc.kill();
  }
}

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
