import { type Address, type Hex } from "viem";
import { type NetworkConfig } from "./config.js";
import { keyHashForSigner } from "./internal/erc1271.js";
import { createPrivateKeySigner, type Signer } from "./internal/signer.js";
import {
  buildPublicClient,
  buildRelayClient,
  keyDescriptorFromSigner,
  submitCalls,
  waitForCalls,
  type KeyDescriptor,
} from "./internal/relay.js";
import {
  buildAdditionalRegisterCall,
  readRegistrationFee,
} from "./internal/keystore.js";
import type { GrantSessionOptions, Session } from "./internal/sessions.js";
import type { Wallet } from "./internal/types.js";

const NATIVE_TOKEN: Address = "0x0000000000000000000000000000000000000000";

/**
 * Grant a scoped session key for a wallet. The admin signer authorizes the
 * session on-chain; from that point forward the session can act on the
 * wallet within its permissions/expiry, enforced by the Altana account
 * contract validator.
 *
 * Pass the returned Session to whichever process runs the agent. The agent
 * calls execute(session, calls) — never the admin.
 */
export async function grantSession(
  wallet: Wallet,
  adminSigner: Signer,
  opts: GrantSessionOptions,
  config: { network: NetworkConfig; feeToken?: Address },
): Promise<Session> {
  const network = config.network;
  const feeToken = config.feeToken ?? NATIVE_TOKEN;

  const sessionSigner = opts.sessionSigner ?? createPrivateKeySigner();

  // Session key descriptor — secp256k1 or passkey (WebAuthnP256), by signer.
  const sessionKeyDesc: KeyDescriptor = keyDescriptorFromSigner(sessionSigner, {
    role: "session",
    expiry: opts.expiry,
    permissions: opts.permissions,
  });

  // Admin descriptor. Only `role` is consumed by submitCalls for signing (the
  // curve is inferred from adminSigner itself), so secp256k1 here is inert even
  // for passkey admins.
  const adminKeyDesc: KeyDescriptor = {
    type: "secp256k1",
    publicKey: adminSigner.publicKey,
    role: "admin",
  };

  const relayClient = buildRelayClient(network);
  const publicClient = buildPublicClient(network);

  // Register the session's public key in KeyStore alongside the Porto
  // authorization. KeyStore is the public registry that lets ANY tool/agent
  // verify this session — without it, the session would only exist inside
  // Porto's smart-account contract and `verify_authorization` would return
  // false. Batched into the same userOp at the cost of one registration fee.
  const fee = await readRegistrationFee(publicClient, network);
  const registerSessionCall = buildAdditionalRegisterCall({
    publicKey: sessionSigner.publicKey,
    fee,
    network,
    expiry: opts.expiry,
  });

  // submitCalls auto-prepends initialRegisterKey(admin) on the wallet's
  // very first admin action, so the final intent ends up as:
  //   [ initialRegisterKey(admin)?, registerKey(session), authorizeKeys=[session] ]
  const callsId = await submitCalls(
    relayClient,
    wallet.address,
    adminSigner,
    [registerSessionCall],
    {
      feeToken,
      submittingKey: adminKeyDesc,
      authorizeKeys: [sessionKeyDesc],
      network,
    },
  );

  const result = await waitForCalls(relayClient, callsId);
  if (result.status !== "CONFIRMED") {
    throw new Error(`Session grant did not confirm: status=${result.status}`);
  }

  // Some public RPCs (notably BSC) return stale eth_call results for
  // a few seconds after a tx confirms. The relay says CONFIRMED, but a follow
  // up read of AltanaAccount.getKeys() can still miss the just-added session
  // key, which makes the very next execute() call fail with "unknown key
  // hash". Wait until the new keyHash is visible from THIS process AND give
  // the relay's separate connection pool time to converge before we hand the
  // Session back to the caller.
  const expectedKeyHash = keyHashForSigner(sessionSigner);
  const startedWait = Date.now();
  await waitForSessionKeyVisible(
    publicClient,
    wallet.address,
    expectedKeyHash,
    30_000,
  );
  // Extra buffer: load-balanced public RPCs serve independent caches to
  // different connection pools. After our process sees the new key, the
  // relay's separate pool can still be ~10s behind. Round up to 12s to be
  // safe; cap the total time we've spent waiting since CONFIRMED at 30s.
  const elapsed = Date.now() - startedWait;
  const relayCatchUpMs = Math.max(0, Math.min(12_000, 30_000 - elapsed));
  if (relayCatchUpMs > 0) {
    await new Promise((r) => setTimeout(r, relayCatchUpMs));
  }

  return {
    walletAddress: wallet.address,
    signer: sessionSigner,
    publicKey: sessionSigner.publicKey,
    permissions: opts.permissions,
    expiry: opts.expiry,
  };
}

const ACCOUNT_GET_KEYS_ABI = [
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        name: "keys",
        type: "tuple[]",
        components: [
          { name: "expiry", type: "uint40" },
          { name: "keyType", type: "uint8" },
          { name: "isSuperAdmin", type: "bool" },
          { name: "publicKey", type: "bytes" },
        ],
      },
      { name: "keyHashes", type: "bytes32[]" },
    ],
  },
] as const;

async function waitForSessionKeyVisible(
  publicClient: ReturnType<typeof buildPublicClient>,
  walletAddress: Address,
  expectedKeyHash: Hex,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const [, keyHashes] = (await publicClient.readContract({
        address: walletAddress,
        abi: ACCOUNT_GET_KEYS_ABI,
        functionName: "getKeys",
        blockTag: "latest",
      })) as readonly [unknown, readonly Hex[]];
      if (keyHashes.includes(expectedKeyHash)) return;
    } catch {
      // Wallet may not be delegated yet on a still-stale read; retry.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Timeout: relay confirmed the grant, but this process's view of the chain
  // never caught up. The session was still written on-chain; the caller can
  // try to use it (execute will retry under the hood once the RPC catches up
  // on the relay's separate connection too).
}
