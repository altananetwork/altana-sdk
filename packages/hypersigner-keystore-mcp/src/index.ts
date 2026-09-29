#!/usr/bin/env bun
/**
 * hypersigner-keystore-mcp: a NON-custodial MCP server for the KeyStore authorization
 * registry. It holds no keys and signs nothing. Read tools answer
 * "is this key authorized right now"; encode tools return ready-to-sign
 * calldata ({to, value, data, chainId}) that the HOST signs with its own key.
 *
 * Chain via ALTANA_CHAIN (default bnb; also "ethereum", "bnb-testnet",
 * "sepolia", and the aliases "celo" -> ethereum, "celo-sepolia" -> sepolia:
 * Celo keeps no KeyStore of its own, its authority is rooted in the Ethereum
 * / Sepolia registry). RPC overridable via RPC_URL (used by the fork tests).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "./version.js";
import {
  createPublicClient,
  http,
  isAddress,
  isHex,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import {
  buildRegisterCall,
  buildRevokeCall,
  deriveKeyId,
  readActiveKeys,
  readIsValidKey,
  readKey,
  readRegistrationFee,
  resolveChain,
} from "./keystore.js";
import { encodeCacheProof, readCacheStatus } from "./cache.js";

const CHAIN = resolveChain(process.env.ALTANA_CHAIN);
const RPC_URL = process.env.RPC_URL || CHAIN.rpcUrl;
/** The L2 read RPC, when the chain was named by an L2 alias. */
const L2_RPC_URL = process.env.L2_RPC_URL || CHAIN.l2?.rpcUrl;
const publicClient = createPublicClient({
  chain: CHAIN.chain,
  transport: http(RPC_URL),
});

function jsonText(value: unknown) {
  const text = JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
  return { content: [{ type: "text" as const, text }] };
}

function assertAddress(v: string): Address {
  if (!isAddress(v)) throw new Error(`Not a valid address: ${v}`);
  return v as Address;
}
function assertBytes32(v: string): Hex {
  if (!isHex(v) || v.length !== 66)
    throw new Error(`Not a valid bytes32 keyId: ${v}`);
  return v as Hex;
}
function assertPublicKey(v: string): Hex {
  if (!isHex(v)) throw new Error("publicKey must be 0x-hex");
  // Defensive: refuse anything shaped like a 32-byte private key.
  if (v.length === 66)
    throw new Error(
      "Refusing a 32-byte value as a public key (looks like a private key). " +
        "Pass a SEC1 public key (65 bytes, 0x04-prefixed) or P256 (64 bytes).",
    );
  return v as Hex;
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "hypersigner-keystore-mcp", version: VERSION },
    {
      instructions:
        "Neutral, non-custodial KeyStore authorization registry on " +
        `${CHAIN.chain.name} (chainId ${CHAIN.chainId}). Reads answer "is this ` +
        'key authorized right now"; encode tools return unsigned calldata for ' +
        "YOUR wallet/SDK to sign. This server never holds a key or signs. " +
        "L2 wallets are rooted here too: an L2 (Celo 42220, Celo Sepolia " +
        "11142220) keeps its KeyStore on the L1 and reads it through a cache, " +
        "so ALTANA_CHAIN=celo resolves to ethereum and ALTANA_CHAIN=celo-sepolia " +
        "to sepolia. Sign encoded calls on the chainId they carry: the registry " +
        "calls on the L1, and the one cache call on the L2. An authorization, a " +
        "timebox or a revoke recorded on the L1 is not visible on the L2 until " +
        "someone relays a proof of it: keystore_cache_status says whether the " +
        "L2 has it, and keystore_encode_cache_proof encodes the call that " +
        "carries it. Relaying is permissionless, so any funded L2 account can " +
        "send it for any user.",
    },
  );

  const tool = (
    server as unknown as {
      registerTool: (name: string, config: unknown, cb: unknown) => unknown;
    }
  ).registerTool.bind(server);

  // ───────────────── reads ─────────────────
  tool(
    "keystore_verify_authorization",
    {
      title: "Verify a key is authorized right now",
      description:
        "One neutral on-chain read: is this key registered for this account, " +
        "not revoked, and not expired? This is the cross-SDK trust check and " +
        "the read a paying counterparty does before honoring an agent.",
      inputSchema: { user: z.string(), keyId: z.string() },
    },
    async ({ user, keyId }: { user: string; keyId: string }) => {
      const addr = assertAddress(user);
      const id = assertBytes32(keyId);
      const authorized = await readIsValidKey(publicClient, CHAIN, addr, id);
      return jsonText({
        user: addr,
        keyId: id,
        authorized,
        chainId: CHAIN.chainId,
        keyStore: CHAIN.keyStore,
      });
    },
  );

  tool(
    "keystore_list_active_keys",
    {
      title: "List a user's active keys",
      description:
        "Enumerate the keys registered for an account, each with liveness, " +
        "expiry, and isRoot. The roster of who may act for this account.",
      inputSchema: { user: z.string() },
    },
    async ({ user }: { user: string }) => {
      const addr = assertAddress(user);
      const ids = await readActiveKeys(publicClient, CHAIN, addr);
      const keys = await Promise.all(
        ids.map(async (keyId) => {
          const [rec, valid] = await Promise.all([
            readKey(publicClient, CHAIN, addr, keyId),
            readIsValidKey(publicClient, CHAIN, addr, keyId),
          ]);
          return {
            keyId,
            valid,
            revoked: rec.revoked,
            expiry: rec.expiry,
            isRoot: rec.isRoot,
            publicKey: rec.publicKey,
          };
        }),
      );
      return jsonText({
        user: addr,
        chainId: CHAIN.chainId,
        count: keys.length,
        keys,
      });
    },
  );

  tool(
    "keystore_get_key",
    {
      title: "Read a single key record",
      description: "Full on-chain Key record for (user, keyId).",
      inputSchema: { user: z.string(), keyId: z.string() },
    },
    async ({ user, keyId }: { user: string; keyId: string }) => {
      const addr = assertAddress(user);
      const id = assertBytes32(keyId);
      const [rec, valid] = await Promise.all([
        readKey(publicClient, CHAIN, addr, id),
        readIsValidKey(publicClient, CHAIN, addr, id),
      ]);
      return jsonText({ user: addr, keyId: id, valid, ...rec });
    },
  );

  tool(
    "keystore_registration_quote",
    {
      title: "Current per-key registration fee",
      description:
        "The one-time, oracle-priced fee (native wei) to register a key. " +
        "Reads are free; revoke is free. Reverts if the price oracle is stale.",
      inputSchema: {},
    },
    async () => {
      const feeWei = await readRegistrationFee(publicClient, CHAIN);
      return jsonText({
        chainId: CHAIN.chainId,
        controller: CHAIN.controller,
        feeWei,
        feeWeiHex: toHex(feeWei),
        currencySymbol: CHAIN.currencySymbol,
        note: "Per-key one-time fee, not per-transaction. Controller refunds excess.",
      });
    },
  );

  // ──────────────── encode (return calldata, never sign) ────────────────
  tool(
    "keystore_encode_register_key",
    {
      title: "Encode a register-key call (you sign it)",
      description:
        "Returns unsigned calldata {to,value,data,chainId} to register a key. " +
        "The Controller records the key under msg.sender, so SIGN AND SEND THIS " +
        "FROM THE ACCOUNT you intend as the on-chain owner. role=root for the " +
        "account's first key (expiry forced 0); role=session for additional keys.",
      inputSchema: {
        publicKey: z.string(),
        role: z.enum(["root", "session"]).default("session"),
        expiry: z.number().optional(),
      },
    },
    async ({
      publicKey,
      role,
      expiry,
    }: {
      publicKey: string;
      role: "root" | "session";
      expiry?: number;
    }) => {
      const pk = assertPublicKey(publicKey);
      const fee = await readRegistrationFee(publicClient, CHAIN);
      const call = buildRegisterCall({
        chain: CHAIN,
        publicKey: pk,
        fee,
        role,
        expiry,
      });
      return jsonText({
        ...call,
        value: call.value,
        valueHex: toHex(call.value),
        decoded: {
          function: role === "root" ? "initialRegisterKey" : "registerKey",
          keyId: deriveKeyId(pk),
          role,
          expiry: role === "root" ? 0 : expiry ?? 0,
        },
        mustSignAs:
          "Sign and send from the account you want as the on-chain owner; the " +
          "key registers under msg.sender. Do not route through a relayer/bundler " +
          "that changes msg.sender.",
        nextStep:
          "Pass {to,value,data,chainId} to your wallet/SDK sign-and-send tool. " +
          "This server does not sign or broadcast.",
      });
    },
  );

  tool(
    "keystore_encode_revoke_key",
    {
      title: "Encode a revoke-key call (you sign it)",
      description:
        "Returns unsigned calldata to revoke a key. value 0, no fee. " +
        "KeyStore requires msg.sender == user, so SIGN AND SEND FROM the user " +
        "account. Revocation is permanent; the root key and the last live key " +
        "cannot be revoked.",
      inputSchema: {
        user: z.string(),
        keyId: z.string().optional(),
        publicKey: z.string().optional(),
      },
    },
    async ({
      user,
      keyId,
      publicKey,
    }: {
      user: string;
      keyId?: string;
      publicKey?: string;
    }) => {
      const addr = assertAddress(user);
      const id = keyId
        ? assertBytes32(keyId)
        : publicKey
          ? deriveKeyId(assertPublicKey(publicKey))
          : (() => {
              throw new Error("Provide either keyId or publicKey.");
            })();
      const call = buildRevokeCall({ chain: CHAIN, user: addr, keyId: id });
      return jsonText({
        ...call,
        value: call.value,
        decoded: { function: "revokeKey", user: addr, keyId: id },
        mustSignAs:
          "msg.sender must equal the user. Sign and send FROM this account.",
        nextStep:
          "Pass {to,value,data,chainId} to your wallet/SDK sign-and-send tool.",
      });
    },
  );

  // ───────────────── L2 cache ─────────────────

  tool(
    "keystore_cache_status",
    {
      title: "Is this key valid on the L2 yet?",
      description:
        "Reads the L2 KeyStoreCache for (user, key) and says which of three " +
        "states it is in: never proven, proven and current, or proven against " +
        "an L1 block the L2 has moved past (which reads as not valid until a " +
        "fresh proof lands, even when nothing changed on the L1). Also returns " +
        "the L1 block the L2 anchors now. Needs ALTANA_CHAIN set to an L2 " +
        "alias (celo, celo-sepolia); naming the registry chain itself leaves " +
        "the mirror ambiguous.",
      inputSchema: {
        user: z.string(),
        keyId: z.string().optional(),
        publicKey: z.string().optional(),
      },
    },
    async ({ user, keyId, publicKey }: { user: string; keyId?: string; publicKey?: string }) => {
      const addr = assertAddress(user);
      const id = keyId
        ? assertBytes32(keyId)
        : publicKey
          ? deriveKeyId(assertPublicKey(publicKey))
          : (() => {
              throw new Error("Provide either keyId or publicKey.");
            })();
      return jsonText(
        await readCacheStatus({ chain: CHAIN, user: addr, keyId: id, ...(L2_RPC_URL ? { rpcUrl: L2_RPC_URL } : {}) }),
      );
    },
  );

  tool(
    "keystore_encode_cache_proof",
    {
      title: "Encode the call that proves an L1 key onto the L2 (you sign it)",
      description:
        "Returns unsigned calldata for the L2 cache's populateKey: the proof " +
        "that carries this key's CURRENT L1 KeyStore state, whether that is an " +
        "authorization, a new expiry or a revocation, to the L2. value 0, no " +
        "fee, and permissionless: sign and send it from ANY funded L2 account, " +
        "not necessarily the user's. Needs the full public key, not the keyId, " +
        "because the cache stores the key. The cache takes the proof only while " +
        "the L2 still anchors the L1 block it was built against, so send it now " +
        "rather than storing it.",
      inputSchema: { user: z.string(), publicKey: z.string() },
    },
    async ({ user, publicKey }: { user: string; publicKey: string }) => {
      const proof = await encodeCacheProof({
        chain: CHAIN,
        user: assertAddress(user),
        publicKey: assertPublicKey(publicKey),
        l1Client: publicClient,
        ...(L2_RPC_URL ? { rpcUrl: L2_RPC_URL } : {}),
      });
      return jsonText({
        ...proof.call,
        decoded: { function: "populateKey", user: proof.user, keyId: proof.keyId },
        provenAt: { l1BlockNumber: proof.l1BlockNumber, l1BlockHash: proof.l1BlockHash },
        provenKeySlot: proof.provenKeySlot,
        l2: proof.l2,
        ...(proof.warning ? { warning: proof.warning } : {}),
        mustSignAs: "Any funded account on the L2; relaying a proof is permissionless.",
        nextStep: proof.advice,
      });
    },
  );

  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[hypersigner-keystore-mcp] ${CHAIN.chain.name} (chainId ${CHAIN.chainId}) — non-custodial, reads + encode only`,
  );
}

// Run as a server only when executed directly (not when imported by tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error("[hypersigner-keystore-mcp] fatal:", err);
    process.exit(1);
  });
}
