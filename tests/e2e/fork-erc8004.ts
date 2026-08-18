/**
 * FORK E2E: ERC-8004 identity against the REAL testnet registry bytecode.
 *
 * Forks BSC testnet (chain 97) — the genuine IdentityRegistry UUPS proxy at
 * 0x8004A818… — and drives what the SDK's builders encode:
 *
 *   1. buildErc8004RegisterCall → Registered decodes, ownerOf(agentId) is the
 *      sender, tokenURI round-trips the record we published.
 *   2. buildErc8004SetAgentUriCall as the owner succeeds; the same call from a
 *      different account reverts (the ERC-721 owner gate).
 *   3. The full two-phase flow: mint with `registrations: []`, patch the id in
 *      with withErc8004Registration, write it back — and read the completed
 *      record off chain with the agentId inside it.
 *   4. _safeMint probe: does the registry _mint or _safeMint? Registers from
 *      three code-bearing senders — one that answers onERC721Received, one
 *      that reverts, and (the one that actually matters) a fresh EOA
 *      delegated by EIP-7702 to the REAL IthacaAccount implementation, which
 *      is exactly what an Altana wallet is. A plain-EOA test cannot see this:
 *      every Altana wallet carries code, so if the registry _safeMints and
 *      IthacaAccount's fallback does not answer the receiver hook, no Altana
 *      wallet could ever hold an identity.
 *   5. The selector-scoped permission gate, against the real account
 *      bytecode: authorize a session key on a delegated account exactly as a
 *      grant does (`authorize` + one `setCanExecute` per permission), then ask
 *      the account's own `canExecute` what that key may do. Proves the two
 *      calls are allowed, that every dangerous registry selector is NOT, and
 *      that a session scoped elsewhere is refused — the bounded-capability
 *      claim itself.
 *
 * Run: bun run fork:erc8004   (needs `anvil`)
 */
import {
  concatHex,
  createTestClient,
  createWalletClient,
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  http,
  padHex,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { bscTestnet } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  buildErc8004RegisterCall,
  buildErc8004SetAgentUriCall,
  createPrivateKeySigner,
  encodeErc8004AgentUri,
  decodeErc8004AgentUri,
  erc8004RegisterPermissions,
  erc8183Addresses,
  getErc8004Agent,
  withErc8004Registration,
  type Erc8004RegistrationFile,
} from "@altananetwork/sdk";
import { keyHashForSigner } from "../../packages/wallet/src/internal/erc1271.js";

const REGISTRY = erc8183Addresses(97).registry;
// `||`, not `??`: an unset GitHub Actions secret arrives as an empty string,
// which would be handed to `anvil --fork-url` verbatim.
const RPC = process.env.BSC_TESTNET_FORK_RPC_URL || "https://data-seed-prebsc-1-s1.binance.org:8545";
const ANVIL_PORT = 8552;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const REGISTERED_EVENT = {
  type: "event",
  name: "Registered",
  inputs: [
    { name: "agentId", type: "uint256", indexed: true },
    { name: "agentURI", type: "string", indexed: false },
    { name: "owner", type: "address", indexed: true },
  ],
} as const;

/** Minimal runtime that answers onERC721Received with the magic selector. */
const ACCEPTS_ERC721: Hex = "0x63150b7a0260e01b60005260206000f3";
/** Minimal runtime that reverts on every call, onERC721Received included. */
const REJECTS_ERC721: Hex = "0x60006000fd";
/**
 * What an Altana wallet's code actually is: the EIP-7702 delegation to the
 * relay's account proxy (porto's `prepareUpgradeAccount` delegates to
 * `contracts.accountProxy`). Read from the testnet relay so a rotated
 * deployment cannot make this probe quietly test the wrong bytecode; the
 * pinned value is the fallback when the relay is unreachable.
 */
const TESTNET_ACCOUNT_PROXY: Address = "0x4f4DDE38dA9f8abBB96c48ca520b992D4bAdC3d6";

async function accountProxyAddress(): Promise<{ address: Address; source: string }> {
  try {
    const res = await fetch("https://testnet-relay.altana.network", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "wallet_getCapabilities", params: [["0x61"]] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json();
    const address = body?.result?.["0x61"]?.contracts?.accountProxy?.address;
    if (typeof address === "string") return { address: address as Address, source: "testnet relay" };
  } catch {
    // Fall through to the pinned value.
  }
  return { address: TESTNET_ACCOUNT_PROXY, source: "pinned fallback" };
}

/**
 * The slice of IthacaAccount a grant touches. `canExecute` is the account's
 * own authorization predicate for a key — the same policy GuardedExecutor
 * enforces when a session-signed intent arrives.
 */
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
    name: "setCanExecute",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "keyHash", type: "bytes32" },
      { name: "target", type: "address" },
      { name: "fnSel", type: "bytes4" },
      { name: "can", type: "bool" },
    ],
    outputs: [],
  },
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

/** KeyType enum: P256=0, WebAuthnP256=1, Secp256k1=2, External=3. */
const KEY_TYPE_SECP256K1 = 2;

const test = createTestClient({ mode: "anvil", chain: bscTestnet, transport: http(ANVIL_URL) });
const publicClient = createPublicClient({ chain: bscTestnet, transport: http(ANVIL_URL) });
const network = { chain: bscTestnet, chainId: 97, publicRpcUrl: ANVIL_URL } as never;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
async function waitForAnvil() {
  for (let i = 0; i < 60; i++) {
    try { await publicClient.getBlockNumber(); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error("anvil not ready");
}

const file = (name: string): Erc8004RegistrationFile => ({
  type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
  name,
  description: "Fork-test agent for the Altana SDK's ERC-8004 support.",
  image: "",
  services: [{ name: "A2A", endpoint: "https://fork.example/.well-known/agent-card.json" }],
  registrations: [],
});

/** Send a call from `from` and return its receipt; anvil impersonates for us. */
async function sendAs(from: Address, call: { to: Address; data?: Hex }) {
  const wallet = createWalletClient({ account: from, chain: bscTestnet, transport: http(ANVIL_URL) });
  const hash = await wallet.sendTransaction({ to: call.to, data: call.data, gas: 2_000_000n });
  return publicClient.waitForTransactionReceipt({ hash });
}

/** The agentId the registry minted to `owner` in this receipt. */
function agentIdFrom(receipt: { logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] }, owner: Address) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== REGISTRY.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: [REGISTERED_EVENT],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data,
      });
      if (decoded.args.owner.toLowerCase() === owner.toLowerCase()) return decoded.args.agentId;
    } catch {
      // Not a Registered log — the mint also emits Transfer.
    }
  }
  throw new Error(`no Registered event for ${owner} in the receipt`);
}

/** Register from an address carrying `code`; returns whether the mint landed. */
async function registerFromCodeBearingAccount(code: Hex, label: string): Promise<boolean> {
  const addr = privateKeyToAccount(generatePrivateKey()).address;
  await test.setBalance({ address: addr, value: 10n ** 19n });
  await test.setCode({ address: addr, bytecode: code });
  await test.impersonateAccount({ address: addr });
  try {
    const receipt = await sendAs(addr, buildErc8004RegisterCall(97, encodeErc8004AgentUri(file(label))));
    return receipt.status === "success";
  } catch {
    // Reverted at estimation — the mint would not land.
    return false;
  } finally {
    await test.stopImpersonatingAccount({ address: addr });
  }
}

/**
 * Authorize a session key on a delegated account with `permissions`, exactly
 * as a grant does, and return its keyHash.
 *
 * The relay builds these calls from a Porto Key; we build the same ones here
 * (porto's `getAuthorizeCalls`: one `authorize`, then one `setCanExecute` per
 * call permission, where a `signature` string becomes its 4-byte selector and
 * a raw hex selector passes through). Doing the translation in the test is the
 * point — it is what pins our permission objects to the on-chain grant.
 */
async function authorizeSessionKey(
  account: Address,
  sessionSigner: ReturnType<typeof createPrivateKeySigner>,
  permissions: readonly { to?: Address; signature?: string }[],
): Promise<Hex> {
  const asAccount = createWalletClient({ account, chain: bscTestnet, transport: http(ANVIL_URL) });
  const send = async (data: Hex) => {
    const hash = await asAccount.sendTransaction({ to: account, data, gas: 2_000_000n });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert(receipt.status === "success", `account self-call reverted (${data.slice(0, 10)})`);
  };

  await send(
    encodeFunctionData({
      abi: ACCOUNT_ABI,
      functionName: "authorize",
      args: [
        {
          expiry: 0,
          keyType: KEY_TYPE_SECP256K1,
          isSuperAdmin: false, // a session key: subject to the guard
          publicKey: padHex(sessionSigner.address, { size: 32 }),
        },
      ],
    }),
  );

  const keyHash = keyHashForSigner(sessionSigner);
  for (const p of permissions) {
    assert(!!p.to && !!p.signature, "every granted permission must name a target AND a selector");
    const selector = p.signature!.startsWith("0x")
      ? (p.signature as Hex)
      : toFunctionSelector(p.signature!);
    await send(
      encodeFunctionData({
        abi: ACCOUNT_ABI,
        functionName: "setCanExecute",
        args: [keyHash, p.to!, selector, true],
      }),
    );
  }
  return keyHash;
}

/** Ask the account itself whether `keyHash` may make this call. */
function canExecute(account: Address, keyHash: Hex, target: Address, data: Hex) {
  return publicClient.readContract({
    address: account,
    abi: ACCOUNT_ABI,
    functionName: "canExecute",
    args: [keyHash, target, data],
  });
}

async function checkPermissionGate(proxy: Address) {
  const account = privateKeyToAccount(generatePrivateKey()).address;
  await test.setBalance({ address: account, value: 10n ** 20n });
  await test.setCode({ address: account, bytecode: concatHex(["0xef0100", proxy]) });
  await test.impersonateAccount({ address: account });

  const uri = encodeErc8004AgentUri(file("Gate Probe"));
  const registerData = buildErc8004RegisterCall(97, uri).data!;
  const setUriData = buildErc8004SetAgentUriCall(97, 1n, uri).data!;

  // A session granted exactly what the SDK's helper returns.
  const scoped = createPrivateKeySigner();
  const scopedHash = await authorizeSessionKey(account, scoped, erc8004RegisterPermissions(97) as never);

  assert(await canExecute(account, scopedHash, REGISTRY, registerData), "scoped session may call register");
  assert(await canExecute(account, scopedHash, REGISTRY, setUriData), "scoped session may call setAgentURI");
  console.log("  ✓ register and setAgentURI are allowed");

  // Everything a `{ to: registry }` catch-all would ALSO have authorized. The
  // account owns the identity token, so each of these is a real loss:
  // transfers give it away, approvals outlive the session's revocation, and
  // setAgentWallet/setMetadata poison it.
  const forbidden: [string, Hex][] = [
    ["transferFrom(address,address,uint256)", encodeErc8004Selector("transferFrom(address,address,uint256)")],
    ["safeTransferFrom(address,address,uint256)", encodeErc8004Selector("safeTransferFrom(address,address,uint256)")],
    ["approve(address,uint256)", encodeErc8004Selector("approve(address,uint256)")],
    ["setApprovalForAll(address,bool)", encodeErc8004Selector("setApprovalForAll(address,bool)")],
    ["setAgentWallet(uint256,address,uint256,bytes)", encodeErc8004Selector("setAgentWallet(uint256,address,uint256,bytes)")],
    ["setMetadata(uint256,string,bytes)", encodeErc8004Selector("setMetadata(uint256,string,bytes)")],
    ["register(string)", encodeErc8004Selector("register(string)")], // the wrong overload
  ];
  for (const [label, data] of forbidden) {
    assert(
      !(await canExecute(account, scopedHash, REGISTRY, data)),
      `scoped session must NOT be able to call ${label}`,
    );
  }
  console.log(`  ✓ all ${forbidden.length} dangerous registry selectors are refused`);

  // The right selector at the wrong contract is refused too (AND semantics).
  assert(
    !(await canExecute(account, scopedHash, erc8183Addresses(97).commerce, registerData)),
    "the register selector must not be callable at another contract",
  );
  console.log("  ✓ the same selector at a different target is refused");

  // The bounded-capability claim: a session scoped elsewhere cannot register.
  const elsewhere = createPrivateKeySigner();
  const elsewhereHash = await authorizeSessionKey(account, elsewhere, [
    { to: erc8183Addresses(97).commerce, signature: "fund(uint256,uint256,bytes)" },
  ]);
  assert(
    !(await canExecute(account, elsewhereHash, REGISTRY, registerData)),
    "a session without the ERC-8004 permissions must NOT be able to register",
  );
  console.log("  ✓ a session granted elsewhere cannot register");

  await test.stopImpersonatingAccount({ address: account });
}

/** Selector-only calldata — `canExecute` dispatches on the first 4 bytes. */
function encodeErc8004Selector(signature: string): Hex {
  return toFunctionSelector(signature);
}

async function main() {
  console.log(`\n▶ Booting anvil BSC-testnet fork (${ANVIL_URL}) ...`);
  const anvil = Bun.spawn(["anvil", "--fork-url", RPC, "--port", String(ANVIL_PORT), "--silent"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await waitForAnvil();

    const owner = privateKeyToAccount(generatePrivateKey());
    const stranger = privateKeyToAccount(generatePrivateKey());
    for (const a of [owner.address, stranger.address]) {
      await test.setBalance({ address: a, value: 10n ** 20n });
      await test.impersonateAccount({ address: a });
    }

    // ── 1. Mint, and prove the token is ours. ──
    console.log("▶ register(agentURI, metadata) against the real registry ...");
    const phase1 = file("Fork Sentinel");
    const phase1Uri = encodeErc8004AgentUri(phase1);
    const mint = await sendAs(owner.address, buildErc8004RegisterCall(97, phase1Uri));
    assert(mint.status === "success", "register reverted");
    const agentId = agentIdFrom(mint, owner.address);

    const minted = await getErc8004Agent(network, agentId);
    assert(minted.owner.toLowerCase() === owner.address.toLowerCase(), `ownerOf(${agentId}) is the sender`);
    assert(minted.agentUri === phase1Uri, "tokenURI round-trips the published record");
    console.log(`  ✓ agent ${agentId} minted to ${owner.address}; tokenURI round-trips`);

    // ── 2. The owner gate on setAgentURI. ──
    console.log("▶ setAgentURI: owner allowed, stranger rejected ...");
    const completed = withErc8004Registration(phase1, agentId, 97);
    const completedUri = encodeErc8004AgentUri(completed);

    let strangerReverted = false;
    try {
      const r = await sendAs(stranger.address, buildErc8004SetAgentUriCall(97, agentId, completedUri));
      strangerReverted = r.status !== "success";
    } catch {
      strangerReverted = true;
    }
    assert(strangerReverted, "a non-owner must not be able to rewrite the record");

    const patch = await sendAs(owner.address, buildErc8004SetAgentUriCall(97, agentId, completedUri));
    assert(patch.status === "success", "setAgentURI reverted for the owner");
    console.log(`  ✓ owner rewrote the record; ${stranger.address.slice(0, 10)}… was rejected`);

    // ── 3. The completed two-phase record, read back off chain. ──
    const after = await getErc8004Agent(network, agentId);
    const record = decodeErc8004AgentUri(after.agentUri);
    assert(
      record.registrations.length === 1 &&
        record.registrations[0]!.agentId === Number(agentId) &&
        record.registrations[0]!.agentRegistry === `eip155:97:${REGISTRY}`,
      `the on-chain record names agent ${agentId} on this registry (got ${JSON.stringify(record.registrations)})`,
    );
    console.log(`  ✓ two-phase complete: record on chain carries agentId ${agentId}`);

    // ── 4. Does the registry _mint or _safeMint — and either way, can an
    // actual Altana wallet be minted to? ──
    console.log("▶ _safeMint probe: registering from code-bearing senders ...");
    const acceptingMinted = await registerFromCodeBearingAccount(ACCEPTS_ERC721, "Accepting Receiver");
    const rejectingMinted = await registerFromCodeBearingAccount(REJECTS_ERC721, "Rejecting Receiver");
    assert(acceptingMinted, "an ERC-721-receiving contract account must be able to register");

    if (rejectingMinted) {
      console.log("  · registry uses _mint (no receiver callback) — any code-bearing account can register");
    } else {
      console.log("  · registry uses _safeMint — the recipient MUST answer onERC721Received");
    }

    // The decisive case: a real EIP-7702 Altana wallet. Under _safeMint this
    // is the whole feature's viability, and no plain-EOA test reaches it.
    const proxy = await accountProxyAddress();
    const proxyCode = await publicClient.getCode({ address: proxy.address });
    assert(
      !!proxyCode && proxyCode !== "0x",
      `the account proxy ${proxy.address} (${proxy.source}) is deployed on this fork`,
    );
    const altanaWalletMinted = await registerFromCodeBearingAccount(
      concatHex(["0xef0100", proxy.address]),
      "Altana 7702 Wallet",
    );
    assert(
      altanaWalletMinted,
      "an EIP-7702 Altana wallet must be able to hold an ERC-8004 identity — the registry " +
        "_safeMints and the account's fallback did not answer onERC721Received",
    );
    console.log(`  ✓ an EOA delegated to ${proxy.address} (${proxy.source}) can be minted to`);

    // ── 5. The bounded capability, against the real account bytecode. ──
    console.log("▶ permission gate: what a session scoped by erc8004RegisterPermissions may do ...");
    await checkPermissionGate(proxy.address);

    console.log("\nResult: PASS ✓ — ERC-8004 identity against real registry bytecode.\n");
  } finally {
    anvil.kill();
  }
}

main().catch((e) => {
  console.error("\nResult: FAIL ✗");
  console.error(e);
  process.exit(1);
});
