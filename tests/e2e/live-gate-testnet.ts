/**
 * Live testnet end-to-end: L1-canonical session keys.
 *
 * Registry on Sepolia, execution on Base Sepolia, bridged only by storage proofs.
 * Proves the property the KeyStoreCacheGate exists to provide: a session key
 * works on the L2 while its record is live on L1, and stops when revoked on L1.
 *
 * Requires a funded key. The wallet pays a KeyStore registration fee on Sepolia
 * (~0.00022 ETH) plus gas, and gas on Base Sepolia.
 *
 *   ALTANA_TESTNET_KEY=0x... bun run --filter '@altananetwork/e2e' live:gate-testnet
 *
 * Optional: SEPOLIA_RPC_URL. The default public endpoint refuses eth_getProof for
 * historical blocks ("distance to target block exceeds maximum proof window"),
 * and the L2 anchor always lags L1 head, so proof bridging needs an endpoint that
 * serves historical proofs. Verified working: 1rpc.io, tenderly.
 */
import {
  createClient,
  createPrivateKeySigner,
  signerFromPrivateKey,
  ensureKeyCached,
  syncKeyToL2,
  buildSetCallCheckerCall,
  buildGateLinkCall,
  assertGateCompatiblePermissions,
  assertGateIsSoleGrantPath,
  requireGate,
  SEPOLIA,
  BASE_SEPOLIA,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  encodeFunctionData,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TARGET: Address = "0x000000000000000000000000000000000000cafe";

let pass = 0;
let fail = 0;
const ok = (m: string) => {
  console.log(`  PASS  ${m}`);
  pass++;
};
const bad = (m: string) => {
  console.log(`  FAIL  ${m}`);
  fail++;
};
const check = (m: string, got: unknown, want: unknown) =>
  got === want ? ok(`${m} (${got})`) : bad(`${m} (got ${got}, want ${want})`);

const CAN_EXECUTE_ABI = [
  {
    name: "canExecute",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const GET_EXPIRY_ABI = [
  {
    name: "getExpiry",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "uint40" }],
  },
] as const;

const KEYSTORE_ABI = [
  {
    name: "isValidKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** keyHash = keccak256(abi.encode(uint8(keyType), keccak256(publicKey))), Secp256k1 = 2. */
function keyHashFor(sessionAddress: Address): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "address" }], [sessionAddress]),
  );
  return keccak256(
    encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }], [2, inner]),
  );
}

async function main() {
  const adminKey = process.env.ALTANA_TESTNET_KEY as Hex | undefined;
  if (!adminKey) throw new Error("set ALTANA_TESTNET_KEY");

  const l1Rpc = process.env.SEPOLIA_RPC_URL ?? SEPOLIA.publicRpcUrl;
  const gate = requireGate(BASE_SEPOLIA);

  const admin = signerFromPrivateKey(adminKey);
  const client = createClient({ chains: [SEPOLIA, BASE_SEPOLIA] });

  const l1 = createPublicClient({ chain: SEPOLIA.chain, transport: http(l1Rpc) });
  const l2 = createPublicClient({
    chain: BASE_SEPOLIA.chain,
    transport: http(BASE_SEPOLIA.publicRpcUrl),
  });
  const l2Wallet = createWalletClient({
    account: privateKeyToAccount(adminKey),
    chain: BASE_SEPOLIA.chain,
    transport: http(BASE_SEPOLIA.publicRpcUrl),
  });


  /** Sends one L2 transaction, retrying while the node reports an in-flight limit. */
  async function sendSpaced(tx: never): Promise<Hex> {
    for (let i = 0; i < 12; i++) {
      try {
        return (await l2Wallet.sendTransaction(tx)) as Hex;
      } catch (e) {
        const msg = String(e);
        if (!msg.includes("in-flight transaction limit")) throw e;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    throw new Error("L2 send kept hitting the in-flight transaction limit");
  }

  console.log("=== 1. wallet on Sepolia ===");
  const wallet = await client.createWallet({ signer: admin });
  console.log(`  wallet ${wallet.address}`);
  console.log(`  gate   ${gate}`);
  console.log(`  cache  ${BASE_SEPOLIA.keyStoreCache}`);

  console.log("=== 2. grant a gated session (spend-only) ===");
  // A gated session must not carry call permissions: Porto turns each one into a
  // setCanExecute allowlist entry, which GuardedExecutor consults BEFORE the gate.
  const permissions = { spend: [{ limit: 10n ** 12n, period: "day" as const }] };
  assertGateCompatiblePermissions(permissions);

  const sessionSigner = createPrivateKeySigner();
  const session = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner,
    permissions,
    expiry: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
    chainId: SEPOLIA.chainId,
  });
  const keyId = keccak256(session.publicKey);
  const keyHash = keyHashFor(sessionSigner.address as Address);
  console.log(`  session ${sessionSigner.address}`);
  console.log(`  keyId   ${keyId}`);

  console.log("=== 3. the key is in the L1 KeyStore ===");
  const liveOnL1 = await l1.readContract({
    address: SEPOLIA.keyStore as Address,
    abi: KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [wallet.address, keyId],
  });
  check("KeyStore.isValidKey on Sepolia", liveOnL1, true);
  console.log(
    `  explorer: https://testnet.altana.network/account/${wallet.address}`,
  );

  console.log("=== 4. route this key through the gate on Base Sepolia ===");
  // The L2 leg is driven directly rather than through the relay. Under EIP-7702
  // the EOA *is* the account, so a transaction it sends to itself satisfies
  // `onlyThis`, and a transaction it sends to the gate arrives with the account
  // as msg.sender - which is what the gate scopes bindings by. Going through the
  // relay here would additionally require the account to already be materialized
  // on this chain, which createWallet only arranges lazily per chain.
  // Porto's accountProxy, not its implementation. The relay validates the
  // delegation target and rejects an account delegated straight to the impl
  // with "invalid delegation proxy". This is the authorizationAddress Porto
  // returns in its own quotes.
  const PORTO_ACCOUNT_PROXY: Address =
    "0x7c27e3aecbf42879b64d76f604dc3430f4886462";
  const l2Code = await l2.getCode({ address: wallet.address });
  if (!l2Code || l2Code === "0x") {
    const auth = await l2Wallet.signAuthorization({
      contractAddress: PORTO_ACCOUNT_PROXY,
      executor: "self",
    });
    const h = await sendSpaced({
      to: wallet.address,
      data: "0x",
      authorizationList: [auth],
    } as never);
    await l2.waitForTransactionReceipt({ hash: h });
    console.log(`  delegated the wallet on Base Sepolia (7702): ${h}`);
  }

  // Authorize the session key on the L2 account, then wire the gate. Spend-only:
  // no setCanExecute anywhere, so the gate is the only thing that can grant.
  const AUTHORIZE_ABI = [
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
      outputs: [{ type: "bytes32" }],
    },
  ] as const;

  const sessionPubForAccount = encodeAbiParameters(
    [{ type: "address" }],
    [sessionSigner.address as Address],
  );
  const GET_KEYS_ABI = [
    {
      name: "getKeys",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [
        {
          type: "tuple[]",
          components: [
            { name: "expiry", type: "uint40" },
            { name: "keyType", type: "uint8" },
            { name: "isSuperAdmin", type: "bool" },
            { name: "publicKey", type: "bytes" },
          ],
        },
        { type: "bytes32[]" },
      ],
    },
  ] as const;

  /**
   * setCallChecker calls _isSuperAdmin, which reverts KeyDoesNotExist when the
   * key is not visible. Public Base Sepolia RPCs lag their own state, so the
   * next transaction can be gas-estimated against a view where authorize has
   * not landed yet. Wait for the account to actually report the key.
   */
  async function waitForKey(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const [, hashes] = (await l2.readContract({
        address: wallet.address,
        abi: GET_KEYS_ABI,
        functionName: "getKeys",
      })) as [unknown, readonly Hex[]];
      if (hashes.some((h) => h.toLowerCase() === keyHash.toLowerCase())) return;
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(`account never reported key ${keyHash}`);
  }

  const authorizeTx = {
      to: wallet.address,
      data: encodeFunctionData({
        abi: AUTHORIZE_ABI,
        functionName: "authorize",
        args: [
          {
            expiry: session.expiry,
            keyType: 2,
            isSuperAdmin: false,
            publicKey: sessionPubForAccount,
          },
        ],
      }),
  };
  const SET_SPEND_ABI = [
    {
      name: "setSpendLimit",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "keyHash", type: "bytes32" },
        { name: "token", type: "address" },
        { name: "period", type: "uint8" },
        { name: "limit", type: "uint256" },
      ],
      outputs: [],
    },
  ] as const;

  // The account needs the spend limit too. A non-superadmin session key with no
  // spend permission is rejected by the relay with NoSpendPermissions. This is
  // also what keeps the session bounded WITHOUT a call permission, which would
  // create the setCanExecute allowlist entry that bypasses the gate.
  const spendTx = {
    to: wallet.address,
    data: encodeFunctionData({
      abi: SET_SPEND_ABI,
      functionName: "setSpendLimit",
      args: [keyHash, "0x0000000000000000000000000000000000000000", 2, 10n ** 15n],
    }),
  };

  for (const tx of [
    authorizeTx,
    spendTx,
    buildSetCallCheckerCall({
      wallet: wallet.address,
      keyHash,
      target: TARGET,
      gate,
    }),
    buildGateLinkCall({ gate, keyHash, sessionPublicKey: session.publicKey }),
  ]) {
    // Base Sepolia allows a 7702-delegated account only one in-flight
    // transaction, and the node keeps counting the previous one briefly after
    // the receipt lands, so these must be spaced rather than pipelined.
    const h = await sendSpaced(tx as never);
    await l2.waitForTransactionReceipt({ hash: h });
    if (tx === authorizeTx) await waitForKey();
  }
  console.log("  authorized + setCallChecker + gate link");
  // Public Base Sepolia RPCs lag their own state, so the binding can read as
  // zero for a few seconds after the link lands. Retry rather than treating a
  // stale read as a mismatch.
  for (let i = 0; ; i++) {
    try {
      await assertGateIsSoleGrantPath({
        publicClient: l2 as never,
        wallet: wallet.address,
        keyHash,
        gate,
        expectedKeyId: keyId,
      });
      break;
    } catch (e) {
      if (i >= 10 || !String(e).includes("binding mismatch")) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  ok("gate is the sole grant path (no allowlist entry, binding matches)");

  console.log("=== 5. denied until the L1 proof is bridged ===");
  const beforeBridge = await l2.readContract({
    address: wallet.address,
    abi: CAN_EXECUTE_ABI,
    functionName: "canExecute",
    args: [keyHash, TARGET, "0x"],
  });
  check("account.canExecute before bridging", beforeBridge, false);

  console.log("=== 6. bridge the proof, then allowed ===");
  const cached = await ensureKeyCached({
    l1Client: l1 as never,
    l2Client: l2 as never,
    l2WalletClient: l2Wallet as never,
    l1KeyStore: SEPOLIA.keyStore as Address,
    l2Cache: BASE_SEPOLIA.keyStoreCache,
    user: wallet.address,
    publicKey: session.publicKey,
    onStatus: (s: string) => console.log(`  ${s}`),
  });
  // Regression check for the RLP storage-leaf decode: a cache at VERSION 1.1.0
  // reports a far-future expiry here and never enforces the deadline at all.
  // Read back from chain rather than trusting the value ensureKeyCached returned:
  // public Base Sepolia RPCs lag, and a single read here can still show the
  // pre-populate state.
  let cachedExpiry = Number(cached.expiry);
  for (let i = 0; i < 15 && cachedExpiry !== session.expiry; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const k = (await l2.readContract({
      address: BASE_SEPOLIA.keyStoreCache,
      abi: GET_EXPIRY_ABI,
      functionName: "getExpiry",
      args: [wallet.address, keyId],
    })) as bigint;
    cachedExpiry = Number(k);
  }
  check("cached expiry matches the L1 expiry", cachedExpiry, session.expiry);

  let afterBridge = false;
  for (let i = 0; i < 15 && !afterBridge; i++) {
    afterBridge = (await l2.readContract({
      address: wallet.address,
      abi: CAN_EXECUTE_ABI,
      functionName: "canExecute",
      args: [keyHash, TARGET, "0x"],
    })) as boolean;
    if (!afterBridge) await new Promise((r) => setTimeout(r, 3000));
  }
  check("account.canExecute after bridging", afterBridge, true);

  console.log("=== 7. the session key signs and lands a transaction ===");
  const exec = await client.execute({
    session,
    chainId: BASE_SEPOLIA.chainId,
    calls: [{ to: TARGET, value: 1n, data: "0x" }],
  });
  exec?.transactionHash
    ? ok(`session executed on Base Sepolia: ${exec.transactionHash}`)
    : bad("session execution returned no transaction hash");

  console.log("=== 8. revoke on L1, re-bridge, denied ===");
  await client.revokeSession({
    wallet,
    signer: admin,
    session,
    chainId: SEPOLIA.chainId,
  });
  const stillLive = await l1.readContract({
    address: SEPOLIA.keyStore as Address,
    abi: KEYSTORE_ABI,
    functionName: "isValidKey",
    args: [wallet.address, keyId],
  });
  check("KeyStore.isValidKey after revoke", stillLive, false);

  // ensureKeyCached early-returns on a stale-but-valid entry, so a revocation
  // must be propagated with syncKeyToL2 directly.
  // A proof is only valid for the exact L1 block the L2 anchors, and that anchor
  // rotates roughly every 12s - shorter than it takes to build the proof against
  // a public RPC. A miss reverts with "anchor moved", so retry.
  for (let i = 0; ; i++) {
    try {
      await syncKeyToL2({
        l1Client: l1 as never,
        l2Client: l2 as never,
        l2WalletClient: l2Wallet as never,
        l1KeyStore: SEPOLIA.keyStore as Address,
        l2Cache: BASE_SEPOLIA.keyStoreCache,
        user: wallet.address,
        publicKey: session.publicKey,
      });
      break;
    } catch (e) {
      if (i >= 8) throw e;
      console.log(`  anchor moved, retrying (${i + 1})`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  let afterRevoke = true;
  for (let i = 0; i < 10 && afterRevoke; i++) {
    afterRevoke = (await l2.readContract({
      address: wallet.address,
      abi: CAN_EXECUTE_ABI,
      functionName: "canExecute",
      args: [keyHash, TARGET, "0x"],
    })) as boolean;
    if (afterRevoke) await new Promise((r) => setTimeout(r, 3000));
  }
  check("account.canExecute after L1 revocation", afterRevoke, false);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
