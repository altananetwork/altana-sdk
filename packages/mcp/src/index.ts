#!/usr/bin/env bun
/**
 * Altana MCP server.
 *
 * Lets AI hosts (Claude Code, Claude desktop, any MCP client) operate
 * Altana smart-account wallets without custodying private keys. Each tool
 * resolves keys by name from the OS keychain (preferred), a local file, or
 * env vars. Private keys never appear as tool arguments or tool results.
 *
 * v0 tools:
 *   - Identity:  about_altana
 *   - Bootstrap: create_wallet
 *   - Inspect:   list_wallets, wallet_balance, wallet_verification,
 *                verify_authorization, list_sessions
 *   - Operate:   wallet_execute, grant_session, revoke_session, session_execute
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, formatEther, http, parseEther, type Address, type Hex } from "viem";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createClient,
  signerFromPrivateKey,
  fetchWithX402,
  ETHEREUM,
  BNB,
} from "@altananetwork/sdk";
import type { Signer, Wallet } from "@altananetwork/sdk";
import {
  getWalletKey,
  setWalletKey,
  walletKeyExists,
  listWalletKeys,
  getSessionKey,
  setSessionKey,
  deleteSessionKey,
  sessionKeyExists,
} from "./keys.js";
import {
  listSessions,
  getSession,
  saveSession,
  deleteSession,
  type SessionPermissions,
} from "./sessions.js";

// ---------- network ---------------------------------------------------------

// Chain is selected at startup via the ALTANA_CHAIN env var. Defaults to BNB
// Chain. Set ALTANA_CHAIN=ethereum to operate on Ethereum instead. All chains
// use the Altana relay (see the SDK config's relayUrl). One MCP process serves
// one chain; restart with a different ALTANA_CHAIN to switch.
const NETWORKS = {
  bnb: BNB,
  "56": BNB,
  ethereum: ETHEREUM,
  "1": ETHEREUM,
} as const;

const requestedChain = (process.env.ALTANA_CHAIN || "bnb").toLowerCase();
const NETWORK = NETWORKS[requestedChain as keyof typeof NETWORKS] ?? BNB;
if (!(requestedChain in NETWORKS)) {
  console.error(
    `[altana-mcp] Unknown ALTANA_CHAIN="${requestedChain}". ` +
      `Supported: bnb (default), ethereum. Falling back to bnb.`,
  );
}
console.error(
  `[altana-mcp] network: ${NETWORK.chain.name} (chainId ${NETWORK.chainId})`,
);

const client = createClient({ chains: [NETWORK] });
const publicClient = createPublicClient({
  chain: NETWORK.chain,
  transport: http(NETWORK.publicRpcUrl),
});

// ---------- KeyStore (read-only inspection tools) --------------------------

const KEYSTORE_ABI = [
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    name: "getPublicKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bytes" }],
  },
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

function assertAddress(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`Not a valid 0x-prefixed 20-byte address: ${value}`);
  }
  return value as Address;
}
function assertBytes32(value: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`Not a valid 0x-prefixed 32-byte hex: ${value}`);
  }
  return value as Hex;
}
function assertHexBytes(value: string): Hex {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error(`Not a valid 0x-prefixed hex string: ${value}`);
  }
  return value as Hex;
}

/**
 * Make sure the admin's EOA is registered with Porto as a smart account.
 * Required before any admin-signed action — Porto's relay rejects
 * prepareCalls / sendPreparedCalls for unknown accounts with "quotes for
 * unknown accounts are not accepted". registerAccount (inside createWallet)
 * does the EIP-7702 setCode authorization on first run; subsequent runs
 * are harmless on Porto's side. We swallow errors and rely on the next
 * call to fail clearly if something's actually wrong.
 */
async function ensureRegistered(signer: Signer): Promise<void> {
  try {
    await client.createWallet({ signer });
  } catch {
    // Either already registered (most common) or a transient relay error.
    // Subsequent grant/execute will surface real failures.
  }
}

// ---------- server ----------------------------------------------------------

// Compact positioning surfaced at MCP handshake. Clients load this with
// every conversation; the full version is behind the `about_altana` tool.
const SERVER_INSTRUCTIONS = `Altana Agentic Wallet enables a global registry of permissions on-chain, accessible by any agent. Traditional agentic wallets store permissions locally or on centralized servers; Altana's KeyStore makes composable permissions accessible across any chain and any wallet. Call \`about_altana\` for the full positioning.`;

const server = new McpServer(
  {
    name: "altana-agentic-wallet",
    version: "0.2.0",
  },
  {
    instructions: SERVER_INSTRUCTIONS,
  },
);

// MCP SDK's registerTool generic-resolves the input shape across every call,
// which compounds and exceeds TS's inference depth (TS2589). Casting the
// server reference here trades inference for compile-ability — runtime
// behavior is identical, and we hand-validate inputs anyway.
const tool = (server as unknown as {
  registerTool: (name: string, config: any, cb: any) => unknown;
}).registerTool.bind(server);

// Prompts are slash commands the user invokes explicitly (e.g.
// `/altana-agentic-wallet:create-wallet` in Claude Code). Same generic-
// inference issue as tools, so we cast the same way. The description
// field is what appears next to the slash command in autocomplete.
const prompt = (server as unknown as {
  registerPrompt: (name: string, config: any, cb: any) => unknown;
}).registerPrompt.bind(server);

// about_altana — positioning + capability summary. Call when the user asks
// what Altana is, how it differs from other wallets, or why integrate it.
const ABOUT_ALTANA = `# Altana Agentic Wallet

Altana Agentic Wallet enables a global registry of permissions on-chain, accessible by any agent.

Traditional agentic wallets store permissions locally or on centralized servers. Altana's **KeyStore** infrastructure makes composable permissions accessible across any chain and any wallet — enabling:

- **Agent-to-agent verification.** Two AIs acting on the same wallet can verify each other's authority on-chain. No platform in between.
- **Cross-app authorization.** Any DEX, orderbook, or protocol can read whether an agent is authorized — without integrating with the specific wallet vendor.
- **A new class of agent services.** Users hire AI agents through on-chain employment contracts. Anyone can verify what an agent is allowed to do, and revoke is one transaction.
`;

tool(
  "about_altana",
  {
    title: "About Altana Agentic Wallet",
    description:
      "Return the positioning and capability summary for Altana Agentic " +
      "Wallet. Use this when a user asks what Altana is, how it differs " +
      "from other agentic wallet stacks, or why an AI host would integrate it.",
  },
  async () => ({
    content: [
      {
        type: "text",
        text: ABOUT_ALTANA,
      },
    ],
  }),
);

// create_wallet — generates a fresh secp256k1 wallet and stores its PK in
// the OS keychain. The PK never leaves the local machine and never appears
// in a tool result. The user must back it up themselves (Keychain Access
// → search "altana" → copy password → save somewhere secure).
tool(
  "create_wallet",
  {
    title: "Create a new wallet",
    description:
      "Generate a fresh Altana wallet and store its private key in the OS " +
      "keychain. Returns the address and a backup reminder. The private " +
      "key is NEVER returned in the tool result — the user must back it up " +
      "via Keychain Access (or equivalent on their OS). Default name is " +
      "\"default\" if not specified.",
    inputSchema: {
      name: z.string().optional(),
    },
  },
  async ({ name }: { name?: string }) => {
    const walletName = name ?? "default";
    if (await walletKeyExists(walletName)) {
      throw new Error(
        `A wallet named "${walletName}" already exists. Pick a different name, ` +
          `or use list_wallets to see what's already there.`,
      );
    }
    const privateKey = generatePrivateKey();
    const address = privateKeyToAccount(privateKey).address;
    await setWalletKey(walletName, privateKey);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name: walletName,
              address,
              storedIn: "OS keychain (service: altana)",
              network: NETWORK.chain.name,
              nextSteps: [
                `Send some funds to this address on ${NETWORK.chain.name}. Your agentic wallet will be activated automatically when you make your first transaction.`,
                `BACK UP the private key. Open Keychain Access (macOS) or your platform's credential manager, find service "altana" / account "${walletName}", copy the password, store it in a password manager or encrypted file. If you lose your machine without a backup, the wallet is gone.`,
                `Once funded, the wallet is ready — call wallet_balance, grant_session, wallet_execute, etc. by name "${walletName}".`,
              ],
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// list_wallets — show every wallet the server can resolve, with source.
tool(
  "list_wallets",
  {
    title: "List wallets",
    description:
      "Enumerate every Altana wallet this server can resolve by name. " +
      "Returns name, address, and source (keychain / file / env). " +
      "Never returns private keys.",
  },
  async () => {
    const keys = await listWalletKeys();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ wallets: keys }, null, 2),
        },
      ],
    };
  },
);

// wallet_balance — native (and optionally ERC-20) balances for a named wallet.
tool(
  "wallet_balance",
  {
    title: "Wallet balance",
    description:
      "Native token balance for a wallet, by name. Pass `tokens` (ERC-20 " +
      "addresses) to include token balances; BEP-677 scaled-UI-amount tokens " +
      "are detected via ERC-165 and their `display` value is scaled by " +
      "uiMultiplier automatically (raw amounts stay unscaled).",
    inputSchema: { name: z.string(), tokens: z.array(z.string()).optional() },
  },
  async ({ name, tokens }: { name: string; tokens?: string[] }) => {
    const key = await getWalletKey(name);
    const res = await client.balances({
      wallet: key.address,
      ...(tokens !== undefined ? { tokens: tokens.map(assertAddress) } : {}),
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              name,
              address: key.address,
              balanceWei: res.native.toString(),
              balanceEth: formatEther(res.native),
              ...(res.tokens !== undefined
                ? {
                    tokens: res.tokens.map((t) =>
                      t.ok
                        ? {
                            address: t.address,
                            symbol: t.symbol,
                            decimals: t.decimals,
                            raw: t.raw.toString(),
                            display: t.display,
                            ...(t.scaled
                              ? {
                                  scaled: {
                                    uiMultiplier: t.scaled.uiMultiplier.toString(),
                                    scaledRaw: t.scaled.scaledRaw.toString(),
                                    ...(t.scaled.pending
                                      ? {
                                          pending: {
                                            newUIMultiplier:
                                              t.scaled.pending.newUIMultiplier.toString(),
                                            effectiveAt:
                                              t.scaled.pending.effectiveAt.toString(),
                                          },
                                        }
                                      : {}),
                                  },
                                }
                              : {}),
                          }
                        : { address: t.address, error: t.error },
                    ),
                  }
                : {}),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// wallet_verification — read-only KeyStore lookup. Works for ANY wallet
// address, not just ones this server has keys for. The cross-tool / cross-
// agent verification primitive: any party can query the on-chain registry
// to enumerate every authorized key on a given wallet.
tool(
  "wallet_verification",
  {
    title: "Verify wallet authorities via KeyStore",
    description:
      "Read the on-chain KeyStore registry for any wallet address. Returns " +
      "every authorized key + its public key bytes. This is how agents and " +
      "tools verify wallet authority without contacting the wallet owner.",
    inputSchema: { address: z.string() },
  },
  async ({ address }: { address: string }) => {
    const addr = assertAddress(address);
    const keys = (await publicClient.readContract({
      address: NETWORK.keyStore,
      abi: KEYSTORE_ABI,
      functionName: "getKeys",
      args: [addr],
    })) as readonly Hex[];

    const details = await Promise.all(
      keys.map(async (keyId) => {
        const publicKey = (await publicClient.readContract({
          address: NETWORK.keyStore,
          abi: KEYSTORE_ABI,
          functionName: "getPublicKey",
          args: [addr, keyId],
        })) as Hex;
        return { keyId, publicKey };
      }),
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              address,
              keyStore: NETWORK.keyStore,
              network: NETWORK.chain.name,
              activeKeyCount: keys.length,
              keys: details,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// verify_authorization — single-call check: "is this key authorized on
// this wallet right now?" The high-frequency primitive for cross-agent /
// cross-tool trust. Accepts a keyId directly, OR a sessionName that the
// server resolves to its keyId via local session metadata.
tool(
  "verify_authorization",
  {
    title: "Verify authorization",
    description:
      "Ask KeyStore whether a key is currently authorized on a wallet. " +
      "Returns a boolean plus the keyId that was checked. Pass either " +
      "`{ walletAddress, keyId }` for a direct check or `{ sessionName }` " +
      "to look up a session this server granted (server resolves the " +
      "wallet and keyId from local metadata).",
    inputSchema: {
      walletAddress: z.string().optional(),
      keyId: z.string().optional(),
      sessionName: z.string().optional(),
    },
  },
  async ({
    walletAddress,
    keyId,
    sessionName,
  }: {
    walletAddress?: string;
    keyId?: string;
    sessionName?: string;
  }) => {
    let addr: Address;
    let id: Hex;

    if (sessionName) {
      const stored = await getSession(sessionName);
      addr = stored.walletAddress;
      id = keccak256(stored.publicKey);
    } else {
      if (!walletAddress || !keyId) {
        throw new Error(
          "Provide either `sessionName`, or both `walletAddress` and `keyId`.",
        );
      }
      addr = assertAddress(walletAddress);
      id = assertBytes32(keyId);
    }

    const valid = (await publicClient.readContract({
      address: NETWORK.keyStore,
      abi: KEYSTORE_ABI,
      functionName: "isValidKey",
      args: [addr, id],
    })) as boolean;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              walletAddress: addr,
              keyId: id,
              ...(sessionName ? { sessionName } : {}),
              authorized: valid,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// wallet_execute — admin-signed transaction from a named wallet.
tool(
  "wallet_execute",
  {
    title: "Execute as wallet admin",
    description:
      "Sign and submit a transaction from a wallet using its admin key. " +
      "On the wallet's first admin action, the SDK auto-registers the " +
      "admin's public key in KeyStore. " +
      "SECURITY: this is full admin authority — DO NOT enable 'always allow' " +
      "for this tool. For routine flows, use grant_session to mint a scoped " +
      "session key and run session_execute instead. Reserve wallet_execute " +
      "for one-off admin operations (granting/revoking sessions, manual " +
      "recovery, etc.) where you can review each call.",
    inputSchema: {
      name: z.string(),
      to: z.string(),
      valueEth: z.string().optional(),
      data: z.string().optional(),
    },
  },
  async ({
    name,
    to,
    valueEth,
    data,
  }: {
    name: string;
    to: string;
    valueEth?: string;
    data?: string;
  }) => {
    const key = await getWalletKey(name);
    const recipient = assertAddress(to);
    const dataHex = data ? assertHexBytes(data) : ("0x" as Hex);
    const signer = signerFromPrivateKey(key.privateKey);
    await ensureRegistered(signer);
    const wallet: Wallet = {
      address: key.address,
    };
    const result = await client.execute({
      wallet,
      signer,
      calls: {
        to: recipient,
        value: parseEther(valueEth ?? "0"),
        data: dataHex,
      },
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              from: key.address,
              status: result.status,
              callsId: result.callsId,
              transactionHash: result.transactionHash,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// list_sessions — enumerate persisted sessions (names + metadata, no PKs).
tool(
  "list_sessions",
  {
    title: "List sessions",
    description:
      "Enumerate every session key authorized through this MCP server. " +
      "Returns name, wallet, address, permissions, and expiry — never " +
      "private keys.",
  },
  async () => {
    const sessions = await listSessions();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ sessions }, null, 2),
        },
      ],
    };
  },
);

// grant_session — admin authorizes a fresh session key on-chain. The
// session's PK is generated server-side, stored in the OS keychain
// (server writes ONLY session keys, never wallet keys), and its metadata
// is persisted at ~/.altana/sessions.json so session_execute can rebuild
// the exact Session object Porto requires.
//
// Wallet must be funded — the grant tx pays Porto relay fees + auto-
// prepended KeyStore.initialRegisterKey (~$0.50). Check wallet_balance
// before calling this.
tool(
  "grant_session",
  {
    title: "Grant a scoped session key",
    description:
      "Admin (a named wallet) authorizes a fresh session key on-chain. " +
      "Session is scoped by recipient, daily ETH spend cap, and lifetime. " +
      "The wallet needs to be funded first — check with wallet_balance " +
      "before calling.",
    inputSchema: {
      walletName: z.string(),
      sessionName: z.string(),
      recipient: z.string(),
      dailyCapEth: z.string().optional(),
      // Cap at 1 year. Sessions are short-lived delegations by design;
      // anything longer should be a fresh re-issue, not a single grant.
      lifetimeSeconds: z.number().int().positive().max(31_536_000).optional(),
    },
  },
  async ({
    walletName,
    sessionName,
    recipient,
    dailyCapEth,
    lifetimeSeconds,
  }: {
    walletName: string;
    sessionName: string;
    recipient: string;
    dailyCapEth?: string;
    lifetimeSeconds?: number;
  }) => {
    // Refuse to overwrite an existing session entry. Sessions live in their
    // own keychain namespace (altana-session), so this only collides with
    // other sessions, never with admin wallets. Defense in depth on top of
    // the structural namespace split.
    if (await sessionKeyExists(sessionName)) {
      throw new Error(
        `A session named "${sessionName}" already exists. Pick a different ` +
          `name, or revoke the existing one first with revoke_session.`,
      );
    }
    const admin = await getWalletKey(walletName);
    const adminSigner = signerFromPrivateKey(admin.privateKey);
    await ensureRegistered(adminSigner);
    const recipientAddr = assertAddress(recipient);
    const capEth = dailyCapEth ?? "0.01";
    const lifetime = lifetimeSeconds ?? 3600;
    const expiry = Math.floor(Date.now() / 1000) + lifetime;
    const capWei = parseEther(capEth);

    // Generate the session PK locally. Never leaves this process.
    const sessionPk = generatePrivateKey();
    const sessionSigner = signerFromPrivateKey(sessionPk);

    const wallet: Wallet = {
      address: admin.address,
    };

    const session = await client.grantSession({
      wallet,
      signer: adminSigner,
      sessionSigner,
      permissions: {
        calls: [{ to: recipientAddr }],
        spend: [{ limit: capWei, period: "day" }],
      },
      expiry,
    });

    // Persist:
    //   1. PK in keychain (encrypted at rest)
    //   2. Metadata in ~/.altana/sessions.json (needed to rebuild Session
    //      at session_execute time — permissions/expiry must match grant
    //      byte-for-byte or Porto can't find the key hash).
    await setSessionKey(sessionName, sessionPk);

    const permissionsForFile: SessionPermissions = {
      calls: [{ to: recipientAddr }],
      spend: [{ limit: capWei.toString(), period: "day" }],
    };

    await saveSession({
      name: sessionName,
      walletName,
      walletAddress: admin.address,
      publicKey: session.publicKey,
      permissions: permissionsForFile,
      expiry,
      createdAt: new Date().toISOString(),
    });

    const keyId = keccak256(session.publicKey);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionName,
              walletName,
              walletAddress: admin.address,
              sessionAddress: sessionSigner.address,
              sessionPublicKey: session.publicKey,
              // keyId is the canonical identifier in KeyStore. Pass this
              // (or sessionName) to verify_authorization to confirm the
              // session is recognized in the public registry.
              keyId,
              permissions: {
                calls: [{ to: recipientAddr }],
                spend: [{ limitEth: capEth, period: "day" }],
              },
              expiry,
              expiresAt: new Date(expiry * 1000).toISOString(),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// revoke_session — admin pulls authority on-chain. Local artifacts (keychain
// entry + metadata file) are deleted after the on-chain tx confirms.
tool(
  "revoke_session",
  {
    title: "Revoke a session key",
    description:
      "Admin revokes a previously-granted session on-chain. After this " +
      "confirms, the smart-account contract rejects any further calls " +
      "from that key. Local artifacts are also deleted.",
    inputSchema: {
      sessionName: z.string(),
    },
  },
  async ({ sessionName }: { sessionName: string }) => {
    const stored = await getSession(sessionName);
    const admin = await getWalletKey(stored.walletName);
    const adminSigner = signerFromPrivateKey(admin.privateKey);
    await ensureRegistered(adminSigner);
    const wallet: Wallet = {
      address: admin.address,
    };

    // SDK revokeSession accepts a public key (hex) to identify the session.
    const result = await client.revokeSession({
      wallet,
      signer: adminSigner,
      session: stored.publicKey,
    });

    // Clean up local artifacts regardless of on-chain status — if the
    // revoke confirmed, the session is dead; if it didn't, retrying will
    // re-issue and we'd rather not have stale state.
    await deleteSessionKey(sessionName);
    await deleteSession(sessionName);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionName,
              status: result.status,
              transactionHash: result.transactionHash,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// session_execute — the agent path. Session signs (no biometric anywhere,
// just a server-held secp256k1 key). Reconstructs the Session object from
// the persisted metadata so Porto's key hash matches what was granted.
tool(
  "session_execute",
  {
    title: "Execute as a session key",
    description:
      "Submit a transaction signed by a session key. The session must " +
      "exist in this server's local store (via grant_session). The smart- " +
      "account contract enforces the granted permissions — calls outside " +
      "scope revert at validation.",
    inputSchema: {
      sessionName: z.string(),
      to: z.string(),
      valueEth: z.string().optional(),
      data: z.string().optional(),
    },
  },
  async ({
    sessionName,
    to,
    valueEth,
    data,
  }: {
    sessionName: string;
    to: string;
    valueEth?: string;
    data?: string;
  }) => {
    const stored = await getSession(sessionName);
    const key = await getSessionKey(sessionName);
    const sessionSigner = signerFromPrivateKey(key.privateKey);
    const recipient = assertAddress(to);
    const dataHex = data ? assertHexBytes(data) : ("0x" as Hex);

    // Rebuild the Session shape from persisted metadata. permissions +
    // expiry MUST match what was registered on-chain at grant time so
    // Porto computes the same key hash. We serialize spend.limit as a
    // decimal string in JSON — restore it to bigint here.
    const permissionsRuntime = {
      calls: stored.permissions.calls,
      spend: stored.permissions.spend?.map((s) => ({
        limit: BigInt(s.limit),
        period: s.period,
        ...(s.token ? { token: s.token } : {}),
      })),
    };

    const result = await client.execute({
      session: {
        walletAddress: stored.walletAddress,
        signer: sessionSigner,
        publicKey: stored.publicKey,
        permissions: permissionsRuntime as any,
        expiry: stored.expiry,
      } as any,
      calls: {
        to: recipient,
        value: parseEther(valueEth ?? "0"),
        data: dataHex,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionName,
              walletAddress: stored.walletAddress,
              status: result.status,
              transactionHash: result.transactionHash,
              callsId: result.callsId,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// x402_request — the agent pays for an HTTP resource. Fetches `url`; if the
// server answers 402, signs an x402 payment (Permit2 or EIP-3009) with the
// session key and retries with the X-PAYMENT header. The wallet must already
// have the payment token approved to Permit2 (for the permit2 scheme) and the
// verifying contract approved as a signature checker for the session.
tool(
  "x402_request",
  {
    title: "Pay for an HTTP resource (x402)",
    description:
      "Fetch an HTTP URL, transparently paying an x402/B402 payment challenge " +
      "with a session key. On a 402 response the agent signs the payment " +
      "(Permit2 or EIP-3009) and retries. Requires the wallet to have approved " +
      "the payment token to Permit2 and approved the verifying contract as a " +
      "signature checker for this session.",
    inputSchema: {
      sessionName: z.string(),
      url: z.string(),
      method: z.string().optional(),
      body: z.string().optional(),
    },
  },
  async ({
    sessionName,
    url,
    method,
    body,
  }: {
    sessionName: string;
    url: string;
    method?: string;
    body?: string;
  }) => {
    const stored = await getSession(sessionName);
    const key = await getSessionKey(sessionName);
    const sessionSigner = signerFromPrivateKey(key.privateKey);

    // Rebuild the Session shape from persisted metadata (same as
    // session_execute): permissions + expiry must match the on-chain grant.
    const permissionsRuntime = {
      calls: stored.permissions.calls,
      spend: stored.permissions.spend?.map((s) => ({
        limit: BigInt(s.limit),
        period: s.period,
        ...(s.token ? { token: s.token } : {}),
      })),
    };
    const session = {
      walletAddress: stored.walletAddress,
      signer: sessionSigner,
      publicKey: stored.publicKey,
      permissions: permissionsRuntime as any,
      expiry: stored.expiry,
    } as any;

    const init: RequestInit = {};
    if (method) init.method = method;
    if (body !== undefined) {
      init.body = body;
      init.method = method ?? "POST";
      init.headers = { "content-type": "application/json" };
    }

    const res = await fetchWithX402(session, url, init);
    const text = await res.text();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionName,
              walletAddress: stored.walletAddress,
              url,
              status: res.status,
              paid: res.status !== 402,
              body: text.slice(0, 4000),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------- prompts (slash commands the user can invoke) -------------------

// Each prompt's `description` is the one-line label that surfaces next to
// the slash command in the client's autocomplete. The callback returns a
// user-role message that tells Claude what to do — typically "call this
// tool, then summarize" — so the prompt becomes an entry point into one
// of our tools without the user having to know the tool name.

prompt(
  "about",
  {
    title: "About Altana",
    description:
      "Explain what Altana Agentic Wallet is and how it differs from other wallet stacks.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Call the `about_altana` tool and return its result to me verbatim, formatted as markdown.",
        },
      },
    ],
  }),
);

prompt(
  "demos",
  {
    title: "What can I try?",
    description:
      "Show a menu of example flows you can run with this MCP server.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: [
            "Show me a short menu of slash commands I can try with this MCP server, organized by what they do. Format it as markdown. Use exactly these:",
            "",
            "**Start here**",
            "- `/altana-agentic-wallet:create-wallet` — Make a new wallet",
            "- `/altana-agentic-wallet:list-wallets` — See what wallets I have",
            "- `/altana-agentic-wallet:wallet-balance` — Check a wallet's balance",
            "",
            "**Hire and fire AI agents**",
            "- `/altana-agentic-wallet:grant-session` — Give an agent scoped access to a wallet",
            "- `/altana-agentic-wallet:list-sessions` — See active sessions",
            "- `/altana-agentic-wallet:session-execute` — Have an agent run a transaction",
            "- `/altana-agentic-wallet:revoke-session` — Cancel an agent's access",
            "",
            "**Verify on-chain (works for any Altana wallet, not just mine)**",
            "- `/altana-agentic-wallet:wallet-info` — Show every authorized key on a wallet",
            "- `/altana-agentic-wallet:verify-session` — Check if a specific session is authorized",
            "",
            "**Other**",
            "- `/altana-agentic-wallet:send-tx` — Send a transaction from a wallet (admin path)",
            "- `/altana-agentic-wallet:about` — Learn what Altana is and how it's different",
            "",
            "Don't add commentary. Just print the menu.",
          ].join("\n"),
        },
      },
    ],
  }),
);

prompt(
  "create-wallet",
  {
    title: "Create wallet",
    description:
      "Generate a new Altana wallet. The private key is created locally and stored in your OS keychain — Altana never sees it.",
    argsSchema: { name: z.string().optional() },
  },
  ({ name }: { name?: string }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: name
            ? `Call the create_wallet tool with name="${name}". Then tell me the address, where the key is stored, and what to do next.`
            : `Call the create_wallet tool. Then tell me the address, where the key is stored, and what to do next.`,
        },
      },
    ],
  }),
);

prompt(
  "list-wallets",
  {
    title: "List wallets",
    description:
      "Show every Altana wallet stored on this machine — names and addresses, never private keys.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Call the list_wallets tool and show me each wallet's name, address, and source as a clean list.",
        },
      },
    ],
  }),
);

prompt(
  "wallet-balance",
  {
    title: "Wallet balance",
    description: "Check the native token balance of a Altana wallet by name.",
    argsSchema: { name: z.string().optional() },
  },
  ({ name }: { name?: string }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Call wallet_balance for wallet "${name ?? "default"}". Show the address and balance in ETH.`,
        },
      },
    ],
  }),
);

prompt(
  "wallet-info",
  {
    title: "Wallet info from KeyStore",
    description:
      "Show every key authorized on any Altana wallet by reading the on-chain KeyStore registry.",
    argsSchema: { address: z.string().optional() },
  },
  ({ address }: { address?: string }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: address
            ? `Call wallet_verification for the address ${address}. Show me each authorized key with its keyId and a shortened public key.`
            : `Ask me for the wallet address I want to look up, then call wallet_verification with it. Show each authorized key clearly.`,
        },
      },
    ],
  }),
);

prompt(
  "verify-session",
  {
    title: "Verify a session is authorized",
    description:
      "Confirm on-chain whether a session is currently authorized on its wallet. Works across any Altana wallet, no integration needed.",
    argsSchema: {
      sessionName: z.string().optional(),
      walletAddress: z.string().optional(),
      keyId: z.string().optional(),
    },
  },
  ({
    sessionName,
    walletAddress,
    keyId,
  }: {
    sessionName?: string;
    walletAddress?: string;
    keyId?: string;
  }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: sessionName
            ? `Call verify_authorization with sessionName="${sessionName}". Tell me whether the session is currently authorized on its wallet.`
            : walletAddress && keyId
            ? `Call verify_authorization with walletAddress="${walletAddress}" and keyId="${keyId}". Tell me yes or no.`
            : `Ask me which session to verify — by sessionName if it's one of mine, or by walletAddress + keyId if I'm verifying a third party's session.`,
        },
      },
    ],
  }),
);

prompt(
  "list-sessions",
  {
    title: "List sessions",
    description:
      "Show every session this server has granted, with their permissions and expiry.",
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: "Call list_sessions and show me each session's name, wallet, allowed recipient, daily cap, and expiry as a clean table.",
        },
      },
    ],
  }),
);

prompt(
  "grant-session",
  {
    title: "Grant a session to an agent",
    description:
      "Give an AI agent scoped permission to act on your wallet — recipient, daily cap, expiry. Authorization is on-chain.",
    argsSchema: {
      walletName: z.string().optional(),
      sessionName: z.string().optional(),
      recipient: z.string().optional(),
      dailyCapEth: z.string().optional(),
      lifetimeSeconds: z.string().optional(),
    },
  },
  (args: {
    walletName?: string;
    sessionName?: string;
    recipient?: string;
    dailyCapEth?: string;
    lifetimeSeconds?: string;
  }) => {
    const missing: string[] = [];
    if (!args.walletName) missing.push("which wallet to grant from (walletName)");
    if (!args.sessionName) missing.push("a name for the session (sessionName)");
    if (!args.recipient) missing.push("the recipient address the agent is allowed to send to");
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              missing.length > 0
                ? `Before granting a session, ask me for: ${missing.join(", ")}. ` +
                  `Defaults available: dailyCapEth=0.01, lifetimeSeconds=3600. ` +
                  `Once I've given you the values, call grant_session and tell me the session address, keyId, and expiry.`
                : `Call grant_session with walletName="${args.walletName}", sessionName="${args.sessionName}", recipient="${args.recipient}"${args.dailyCapEth ? `, dailyCapEth="${args.dailyCapEth}"` : ""}${args.lifetimeSeconds ? `, lifetimeSeconds=${args.lifetimeSeconds}` : ""}. Show me the session address, keyId, and expiry.`,
          },
        },
      ],
    };
  },
);

prompt(
  "session-execute",
  {
    title: "Run a transaction as an agent",
    description:
      "Have a session key submit a transaction. No biometric, no admin signature — the smart contract enforces the session's scope.",
    argsSchema: {
      sessionName: z.string().optional(),
      to: z.string().optional(),
      valueEth: z.string().optional(),
    },
  },
  (args: { sessionName?: string; to?: string; valueEth?: string }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            !args.sessionName || !args.to
              ? `Ask me which session should run, where to send to, and how much ETH. Then call session_execute and report the tx hash.`
              : `Call session_execute with sessionName="${args.sessionName}", to="${args.to}", valueEth="${args.valueEth ?? "0"}". Report the tx status and hash.`,
        },
      },
    ],
  }),
);

prompt(
  "revoke-session",
  {
    title: "Revoke a session",
    description: "Cancel an agent's session. Takes effect on-chain immediately.",
    argsSchema: { sessionName: z.string().optional() },
  },
  ({ sessionName }: { sessionName?: string }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: sessionName
            ? `Call revoke_session for sessionName="${sessionName}". Confirm the tx hash and that the session is no longer authorized.`
            : `Ask me which session to revoke (use list_sessions if I'm not sure), then call revoke_session.`,
        },
      },
    ],
  }),
);

prompt(
  "send-tx",
  {
    title: "Send a transaction from a wallet",
    description:
      "Sign a transaction with a wallet's admin key. The wallet must be funded.",
    argsSchema: {
      name: z.string().optional(),
      to: z.string().optional(),
      valueEth: z.string().optional(),
    },
  },
  (args: { name?: string; to?: string; valueEth?: string }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            !args.name || !args.to
              ? `Ask me which wallet to send from, the recipient, and the amount in ETH. Then call wallet_execute.`
              : `Call wallet_execute with name="${args.name}", to="${args.to}", valueEth="${args.valueEth ?? "0"}". Report the tx status and hash.`,
        },
      },
    ],
  }),
);

// ---------- boot ------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
