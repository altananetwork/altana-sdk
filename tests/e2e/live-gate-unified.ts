/**
 * Live proof of the UNIFIED cross-chain SDK: granting and executing on a gated
 * L2 (Base Sepolia) is now a single client.grantSession / client.execute — the
 * SDK hides the L1 grant, the L2 gate wiring, and the proof bridge. The UI code
 * is identical to a full-stack chain.
 *
 *   ALTANA_TESTNET_KEY=0x...  (admin, funds the wallet on Sepolia + Base Sepolia)
 *   SEPOLIA_RPC_URL=https://sepolia.gateway.tenderly.co  (must serve historical eth_getProof)
 *   L2_RELAYER_KEY=0x...  (funded Base Sepolia EOA that pays the populateKey gas)
 *     bun run --filter '@altananetwork/e2e' live:gate-unified
 */
import {
  createClient,
  createPrivateKeySigner,
  signerFromPrivateKey,
  BASE_SEPOLIA,
  SEPOLIA,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  http,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
} from "viem";

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
  const relayerKey = process.env.L2_RELAYER_KEY as Hex | undefined;
  if (!adminKey) throw new Error("set ALTANA_TESTNET_KEY");
  if (!relayerKey) throw new Error("set L2_RELAYER_KEY (funded Base Sepolia EOA)");

  const admin = signerFromPrivateKey(adminKey);

  // The SDK builds its internal L1 client from SEPOLIA.publicRpcUrl. Point it at
  // a proof-serving endpoint (public Sepolia refuses historical eth_getProof).
  (SEPOLIA as { publicRpcUrl: string }).publicRpcUrl =
    process.env.SEPOLIA_RPC_URL ?? SEPOLIA.publicRpcUrl;

  // The whole cross-chain setup is declared ONCE, here. SEPOLIA must be in
  // chains so the SDK can find the L2's L1 registry; relayers funds the proof
  // bridge. After this, the calling code is chain-type agnostic.
  const client = createClient({
    chains: [SEPOLIA, BASE_SEPOLIA],
    relayers: { [BASE_SEPOLIA.chainId]: signerFromPrivateKey(relayerKey) },
  });

  const l2 = createPublicClient({
    chain: BASE_SEPOLIA.chain,
    transport: http(BASE_SEPOLIA.publicRpcUrl),
  });

  console.log("=== 1. create a wallet ===");
  const wallet = await client.createWallet({ signer: admin });
  console.log(`  wallet ${wallet.address}`);

  console.log("=== 2. grant a session on Base Sepolia — ONE call ===");
  // Identical to a BNB grant. permissions.calls[].to = the contract the session
  // may call; on this gated L2 the SDK routes it through the gate. The SDK does
  // grant(L1 Sepolia) + wire(L2 gate) + bridge(proof) internally.
  const sessionSigner = createPrivateKeySigner();
  const session = await client.grantSession({
    wallet,
    signer: admin,
    sessionSigner,
    permissions: {
      calls: [{ to: TARGET }],
      spend: [{ limit: 10n ** 15n, period: "day" }],
    },
    expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    chainId: BASE_SEPOLIA.chainId,
    onStatus: (s) => console.log(`    bridge: ${s}`),
  });
  const keyHash = keyHashFor(sessionSigner.address as Address);
  console.log(`  session ${sessionSigner.address}`);
  ok("grantSession returned (grant + wire + bridge done by the SDK)");
  check("result carries l2 wiring", session.l2?.chainId, BASE_SEPOLIA.chainId);
  check("l2 proof cached", session.l2?.cached, true);

  console.log("=== 3. the account authorizes it on Base Sepolia ===");
  let allowed = false;
  for (let i = 0; i < 10 && !allowed; i++) {
    allowed = (await l2.readContract({
      address: wallet.address,
      abi: CAN_EXECUTE_ABI,
      functionName: "canExecute",
      args: [keyHash, TARGET, "0x"],
    })) as boolean;
    if (!allowed) await new Promise((r) => setTimeout(r, 3000));
  }
  check("account.canExecute on Base Sepolia", allowed, true);

  console.log("=== 4. execute with the session — ONE call, auto-bridged ===");
  const exec = await client.execute({
    session,
    chainId: BASE_SEPOLIA.chainId,
    calls: [{ to: TARGET, value: 1n, data: "0x" }],
  });
  exec?.transactionHash
    ? ok(`session executed on Base Sepolia: ${exec.transactionHash}`)
    : bad("execute returned no transaction hash");

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  console.log(`account: https://testnet.altana.network/account/${wallet.address}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
