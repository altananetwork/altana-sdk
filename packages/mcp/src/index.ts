#!/usr/bin/env bun
/**
 * Altana MCP server.
 *
 * Lets AI hosts (Claude Code, Claude desktop, any MCP client) operate
 * Altana smart-account wallets without custodying private keys. Each tool
 * resolves keys by name from the OS keychain (preferred), a local file, or
 * env vars. Private keys never appear as tool arguments or tool results.
 *
 * Tools:
 *   - Identity:  about_altana
 *   - Bootstrap: create_wallet
 *   - Inspect:   list_wallets, wallet_balance, wallet_verification,
 *                verify_authorization, list_sessions
 *   - Operate:   wallet_execute, grant_session, revoke_session, session_execute
 *   - Pay:       x402_request
 *   - Jobs:      erc8183_create_job, erc8183_job_status, erc8183_settle,
 *                erc8183_submit
 *   - Agent ID:  erc8004_register, erc8004_set_agent_uri, erc8004_show
 *   - Skills:    search_skills, get_skill
 *
 * Not every tool has a slash command; see docs.altana.network/mcp/tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { VERSION } from "./version.js";
import { formatBalance } from "./balanceFormat.js";
import { createPublicClient, formatUnits, http, parseEther, parseUnits, type Address, type Hex } from "viem";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  createClient,
  deserializeSession,
  signerFromPrivateKey,
  fetchWithX402,
  hireErc8183Agent,
  getErc8183Job,
  getErc8183DeliverableUrl,
  settleErc8183Job,
  submitErc8183Deliverable,
  erc8183Addresses,
  getErc8004Agent,
  setErc8004AgentUri,
  decodeErc8004AgentUri,
  encodeErc8004AgentUri,
  withErc8004Registration,
  ETHEREUM,
  BNB,
  BNB_TESTNET,
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
import { searchSkills, getSkill } from "./skills.js";
import {
  assertErc8004Permissions,
  buildRegistrationFile,
  runErc8004Registration,
  toMetadataEntries,
  type MetadataInput,
} from "./erc8004.js";

// ---------- network ---------------------------------------------------------

// Chain is selected at startup via the ALTANA_CHAIN env var. Defaults to BNB
// Chain. Set ALTANA_CHAIN=ethereum to operate on Ethereum, or
// ALTANA_CHAIN=bnb-testnet for the BSC testnet stack. All chains execute
// through the Altana relay (mainnet relay for mainnets, testnet relay for
// bnb-testnet — see the SDK config's relayUrl). One MCP process serves one
// chain; restart with a different ALTANA_CHAIN to switch. Sepolia/Base Sepolia
// are keystore-only (no relay) and so are not selectable here.
const NETWORKS = {
  bnb: BNB,
  "56": BNB,
  ethereum: ETHEREUM,
  "1": ETHEREUM,
  "bnb-testnet": BNB_TESTNET,
  "bsc-testnet": BNB_TESTNET,
  "97": BNB_TESTNET,
} as const;

const requestedChain = (process.env.ALTANA_CHAIN || "bnb").toLowerCase();
const NETWORK = NETWORKS[requestedChain as keyof typeof NETWORKS] ?? BNB;
if (!(requestedChain in NETWORKS)) {
  console.error(
    `[altana-mcp] Unknown ALTANA_CHAIN="${requestedChain}". ` +
      `Supported: bnb (default), ethereum, bnb-testnet. Falling back to bnb.`,
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
const SERVER_INSTRUCTIONS = `Altana Smart Agentic Wallet enables a global registry of permissions on-chain, accessible by any agent. Traditional agentic wallets store permissions locally or on centralized servers; Altana's KeyStore makes composable permissions accessible across any chain and any wallet. Call \`about_altana\` for the full positioning.`;

const server = new McpServer(
  {
    name: "altana-agentic-wallet",
    version: VERSION,
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
const ABOUT_ALTANA = `# Altana Smart Agentic Wallet

Altana Smart Agentic Wallet enables a global registry of permissions on-chain, accessible by any agent.

Traditional agentic wallets store permissions locally or on centralized servers. Altana's **KeyStore** infrastructure makes composable permissions accessible across any chain and any wallet — enabling:

- **Agent-to-agent verification.** Two AIs acting on the same wallet can verify each other's authority on-chain. No platform in between.
- **Cross-app authorization.** Any DEX, orderbook, or protocol can read whether an agent is authorized — without integrating with the specific wallet vendor.
- **A new class of agent services.** Users hire AI agents through on-chain employment contracts. Anyone can verify what an agent is allowed to do, and revoke is one transaction.
`;

tool(
  "about_altana",
  {
    title: "About Altana Smart Agentic Wallet",
    description:
      "Return the positioning and capability summary for Altana Smart " +
      "Agentic Wallet. Use this when a user asks what Altana is, how it differs " +
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
                `Send some funds to this address on ${NETWORK.chain.name}. Your smart agentic wallet will be activated automatically when you make your first transaction.`,
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
// `tokens` reads an explicit list; `discover` asks the Altana relay which
// tokens the wallet holds and reads those. The two are alternatives.
tool(
  "wallet_balance",
  {
    title: "Wallet balance",
    description:
      "Native token balance for a wallet, by name. Pass `tokens` (ERC-20 " +
      "addresses) to include specific token balances, or `discover: true` to " +
      "list every ERC-20 the wallet holds (discovered through the Altana relay, " +
      "zero balances omitted) — the result then carries `discovered: true`. " +
      "BEP-677 scaled-UI-amount tokens are detected via ERC-165 and their " +
      "`display` value is scaled by uiMultiplier automatically (raw amounts " +
      "stay unscaled). Use `tokens` or `discover`, not both.",
    inputSchema: {
      name: z.string(),
      tokens: z.array(z.string()).optional(),
      discover: z.boolean().optional(),
    },
  },
  async ({ name, tokens, discover }: { name: string; tokens?: string[]; discover?: boolean }) => {
    if (discover && tokens !== undefined) {
      throw new Error(
        "wallet_balance: pass either `tokens` (explicit ERC-20 list) or `discover: true` (list what the wallet holds), not both.",
      );
    }
    const key = await getWalletKey(name);
    const payload = discover
      ? await client.holdings({ wallet: key.address }).then((res) =>
          formatBalance({
            name,
            address: key.address,
            native: res.native,
            tokens: res.tokens,
            discovered: true,
          }),
        )
      : await client
          .balances({
            wallet: key.address,
            ...(tokens !== undefined ? { tokens: tokens.map(assertAddress) } : {}),
          })
          .then((res) =>
            formatBalance({
              name,
              address: key.address,
              native: res.native,
              ...(res.tokens !== undefined ? { tokens: res.tokens } : {}),
            }),
          );
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
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
      "wallet and keyId from local metadata). Note: this reads the public " +
      "KeyStore registry — a session granted with register: false works " +
      "on-chain but reports false here until it is registered.",
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
              ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
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
      register: z
        .boolean()
        .optional()
        .describe(
          "Register the session key in the public KeyStore registry " +
            "(default true). Registered keys are verifiable on-chain by any " +
            "third party via verify_authorization — keep the default unless " +
            "the key is ephemeral and nothing will ever look it up. When " +
            "false, verify_authorization reports the key as not authorized " +
            "even though the session works.",
        ),
    },
  },
  async ({
    walletName,
    sessionName,
    recipient,
    dailyCapEth,
    lifetimeSeconds,
    register,
  }: {
    walletName: string;
    sessionName: string;
    recipient: string;
    dailyCapEth?: string;
    lifetimeSeconds?: number;
    register?: boolean;
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
      ...(register !== undefined ? { register } : {}),
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
              // The grant pays a KeyStore registration fee, twice on a
              // wallet's very first admin action. Surface the receipt so the
              // host can record what the user was actually charged for.
              transactionHash: session.transactionHash,
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
              ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
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
    const recipient = assertAddress(to);
    const dataHex = data ? assertHexBytes(data) : ("0x" as Hex);

    // Rebuild the live Session from the persisted half plus the keychain
    // key. deserializeSession restores the bigint limits and refuses a key
    // that doesn't match the session's registered publicKey.
    const session = deserializeSession(stored, signerFromPrivateKey(key.privateKey));

    const result = await client.execute({
      session,
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
              ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
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

    // Rebuild the live Session (same as session_execute): permissions +
    // expiry must match the on-chain grant; deserializeSession restores
    // the bigint limits and validates the key against the session.
    const session = deserializeSession(stored, signerFromPrivateKey(key.privateKey));

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

// ---------- ERC-8183 (BNB agent economy job escrow) -------------------------

/** Rebuild the runtime Session from persisted metadata + the keychain key. */
async function sessionFromName(sessionName: string) {
  const stored = await getSession(sessionName);
  const key = await getSessionKey(sessionName);
  return {
    stored,
    session: deserializeSession(stored, signerFromPrivateKey(key.privateKey)),
  };
}

// erc8183_create_job — hire an ERC-8183 seller agent (e.g. any BNB Agent
// Studio agent): escrow $U against a provider for a task, in one atomic
// relay intent (createJob → registerJob → setBudget → approve → fund).
tool(
  "erc8183_create_job",
  {
    title: "Hire an agent (ERC-8183 job escrow)",
    description:
      "Hire an ERC-8183 seller agent — e.g. any BNB Agent Studio agent — by " +
      "escrowing $U against its provider address for a task. Runs the whole " +
      "buyer flow (createJob, registerJob, setBudget, approve $U, fund) as ONE " +
      "atomic relay intent signed by the session key. The seller detects the " +
      "funded job, does the work, and submits a deliverable; escrow releases " +
      "after the dispute window via erc8183_settle. budgetU is a decimal $U " +
      "amount, e.g. \"0.2\".",
    inputSchema: {
      sessionName: z.string(),
      provider: z.string().describe("The seller agent's wallet address"),
      task: z.string().describe("The job description the seller will fulfil (≤4096 bytes)"),
      budgetU: z.string().describe("Budget in $U, decimal (e.g. \"0.2\")"),
      deadlineMinutes: z.number().optional(),
    },
  },
  async ({
    sessionName,
    provider,
    task,
    budgetU,
    deadlineMinutes,
  }: {
    sessionName: string;
    provider: string;
    task: string;
    budgetU: string;
    deadlineMinutes?: number;
  }) => {
    const { stored, session } = await sessionFromName(sessionName);
    const result = await hireErc8183Agent(
      session,
      {
        provider: provider as Address,
        task,
        budget: parseUnits(budgetU, 18),
        ...(deadlineMinutes ? { deadlineSeconds: deadlineMinutes * 60 } : {}),
      },
      { network: NETWORK },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionName,
              walletAddress: stored.walletAddress,
              jobId: result.jobId.toString(),
              provider,
              budgetU,
              expiredAt: result.expiredAt.toString(),
              status: result.status,
              ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
              transactionHash: result.transactionHash,
              next: "Poll erc8183_job_status until SUBMITTED, then erc8183_settle after the dispute window.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// erc8183_job_status — read-only job state + deliverable retrieval.
tool(
  "erc8183_job_status",
  {
    title: "Check an ERC-8183 job",
    description:
      "Read an ERC-8183 job's on-chain state (OPEN/FUNDED/SUBMITTED/COMPLETED/" +
      "REJECTED/EXPIRED). When the seller has submitted, also resolves the " +
      "deliverable URL and, for http(s) URLs, fetches the deliverable content.",
    inputSchema: {
      jobId: z.string().describe("The on-chain job id (1-indexed)"),
    },
  },
  async ({ jobId }: { jobId: string }) => {
    const job = await getErc8183Job(NETWORK, BigInt(jobId));
    let deliverableUrl: string | undefined;
    let deliverableContent: string | undefined;
    if (job.submittedAt > 0n) {
      deliverableUrl = await getErc8183DeliverableUrl(NETWORK, BigInt(jobId));
      if (deliverableUrl?.startsWith("http")) {
        try {
          const res = await fetch(deliverableUrl);
          const manifest: any = await res.json();
          deliverableContent = manifest?.response?.content;
        } catch {
          // leave content undefined — the URL is still returned
        }
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              jobId,
              status: job.statusName,
              client: job.client,
              provider: job.provider,
              budgetU: formatUnits(job.budget, 18),
              expiredAt: job.expiredAt.toString(),
              submittedAt: job.submittedAt.toString(),
              deliverableUrl,
              deliverableContent: deliverableContent?.slice(0, 4000),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// erc8183_settle — release (approve) or contest (dispute) a job's escrow.
tool(
  "erc8183_settle",
  {
    title: "Settle or dispute an ERC-8183 job",
    description:
      "Settle an ERC-8183 job. action=\"approve\" (default) releases the escrow " +
      "to the seller — valid once the dispute window after submission has " +
      "elapsed. action=\"dispute\" contests the deliverable — client-only, valid " +
      "only INSIDE the dispute window.",
    inputSchema: {
      sessionName: z.string(),
      jobId: z.string(),
      action: z.enum(["approve", "dispute"]).optional(),
    },
  },
  async ({
    sessionName,
    jobId,
    action,
  }: {
    sessionName: string;
    jobId: string;
    action?: "approve" | "dispute";
  }) => {
    const { stored, session } = await sessionFromName(sessionName);
    const result = await settleErc8183Job(
      session,
      { jobId: BigInt(jobId), ...(action ? { action } : {}) },
      { network: NETWORK },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionName,
              walletAddress: stored.walletAddress,
              jobId,
              action: action ?? "approve",
              status: result.status,
              ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
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

// erc8183_submit — the seller side: submit a job's deliverable. Builds the
// v1 manifest, hashes its canonical form on-chain, and returns the EXACT
// canonical text the agent must serve at deliverableUrl (buyers verify the
// raw served bytes against the on-chain hash).
tool(
  "erc8183_submit",
  {
    title: "Submit an ERC-8183 job deliverable (seller)",
    description:
      "Submit the deliverable for an ERC-8183 job this wallet was hired for " +
      "(the session needs erc8183SubmitPermissions — submit() on the commerce " +
      "kernel). Builds the v1 manifest from `content`, hashes its canonical " +
      "form on-chain, and returns `manifestText` — serve EXACTLY those bytes " +
      "at deliverableUrl, or buyer-side verification fails.",
    inputSchema: {
      sessionName: z.string(),
      jobId: z.string(),
      content: z.string(),
      contentType: z.string().optional(),
      deliverableUrl: z.string(),
    },
  },
  async ({
    sessionName,
    jobId,
    content,
    contentType,
    deliverableUrl,
  }: {
    sessionName: string;
    jobId: string;
    content: string;
    contentType?: string;
    deliverableUrl: string;
  }) => {
    const { stored, session } = await sessionFromName(sessionName);
    const a = erc8183Addresses(NETWORK.chainId);
    const manifest = {
      version: 1 as const,
      job_id: Number(jobId),
      chain_id: NETWORK.chainId,
      contracts: { commerce: a.commerce, router: a.router, policy: a.policy },
      response: { content, content_type: contentType ?? "text/plain" },
      metadata: {},
    };
    const result = await submitErc8183Deliverable(
      session,
      { jobId: BigInt(jobId), manifest, deliverableUrl },
      { network: NETWORK },
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionName,
              walletAddress: stored.walletAddress,
              jobId,
              deliverable: result.deliverable,
              manifestHash: result.deliverable,
              manifestText: result.manifestText,
              status: result.status,
              transactionHash: result.transactionHash,
              next:
                `Serve manifestText VERBATIM (byte-for-byte) at ${deliverableUrl}. ` +
                "The buyer verifies the raw served bytes against the on-chain hash, " +
                "then settles after the dispute window via erc8183_settle.",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------- ERC-8004 (on-chain agent identity) ------------------------------

const METADATA_SCHEMA = z
  .array(z.object({ key: z.string(), value: z.string() }))
  .optional()
  .describe("Extra on-chain metadata entries; values are hex-encoded for you");

// erc8004_register — mint the agent's identity and publish its record.
tool(
  "erc8004_register",
  {
    title: "Register an agent identity (ERC-8004)",
    description:
      "Give this wallet's agent an on-chain identity in the ERC-8004 registry, so " +
      "buyers and other agents can discover and verify it. Runs the full two-phase " +
      "registration: mint the identity token, then write back the registration " +
      "record with the assigned agentId embedded. The session key must have been " +
      "granted the ERC-8004 registry permissions; the tool checks that before " +
      "spending gas. If the mint lands but the write-back fails, the agentId is " +
      "still returned — repair with erc8004_set_agent_uri, never by registering again.",
    inputSchema: {
      sessionName: z.string(),
      name: z.string().describe("The agent's display name"),
      description: z.string().describe("What the agent does"),
      endpoint: z.string().describe("The agent's service URL (for A2A, its agent-card URL)"),
      serviceName: z.string().optional().describe("Protocol name; defaults to \"A2A\""),
      version: z.string().optional(),
      image: z.string().optional(),
      metadata: METADATA_SCHEMA,
    },
  },
  async ({
    sessionName,
    metadata,
    ...fields
  }: {
    sessionName: string;
    name: string;
    description: string;
    endpoint: string;
    serviceName?: string;
    version?: string;
    image?: string;
    metadata?: MetadataInput[];
  }) => {
    const { stored, session } = await sessionFromName(sessionName);
    assertErc8004Permissions(sessionName, stored.permissions, NETWORK.chainId);

    const outcome = await runErc8004Registration({
      session,
      chainId: NETWORK.chainId,
      opts: { network: NETWORK },
      file: buildRegistrationFile(fields),
      metadata: toMetadataEntries(metadata),
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { sessionName, walletAddress: stored.walletAddress, ...outcome },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// erc8004_set_agent_uri — rewrite an existing agent's registration record.
tool(
  "erc8004_set_agent_uri",
  {
    title: "Update an agent's ERC-8004 record",
    description:
      "Rewrite the registration record of an ERC-8004 agent this wallet owns — " +
      "use it to change the agent's endpoint or description, or to repair a " +
      "registration whose write-back failed. Pass either a ready-made agentUri or " +
      "the structured fields (name/description/endpoint), in which case the record " +
      "is rebuilt with agentId embedded. Selector-scoped, not agent-scoped: a " +
      "session that can do this can rewrite any agent the wallet owns.",
    inputSchema: {
      sessionName: z.string(),
      agentId: z.string().describe("The on-chain agent id"),
      agentUri: z.string().optional().describe("A ready-made agent URI; overrides the fields below"),
      name: z.string().optional(),
      description: z.string().optional(),
      endpoint: z.string().optional(),
      serviceName: z.string().optional(),
      version: z.string().optional(),
      image: z.string().optional(),
    },
  },
  async ({
    sessionName,
    agentId,
    agentUri,
    name,
    description,
    endpoint,
    serviceName,
    version,
    image,
  }: {
    sessionName: string;
    agentId: string;
    agentUri?: string;
    name?: string;
    description?: string;
    endpoint?: string;
    serviceName?: string;
    version?: string;
    image?: string;
  }) => {
    const { stored, session } = await sessionFromName(sessionName);
    assertErc8004Permissions(sessionName, stored.permissions, NETWORK.chainId);

    const id = BigInt(agentId);
    let uri = agentUri;
    if (!uri) {
      if (!name || !description || !endpoint) {
        throw new Error(
          "erc8004_set_agent_uri needs either agentUri, or all of name, description and endpoint " +
            "to rebuild the record.",
        );
      }
      const file = buildRegistrationFile({
        name,
        description,
        endpoint,
        ...(serviceName ? { serviceName } : {}),
        ...(version ? { version } : {}),
        ...(image ? { image } : {}),
      });
      uri = encodeErc8004AgentUri(withErc8004Registration(file, id, NETWORK.chainId));
    }

    const result = await setErc8004AgentUri(session, { agentId: id, agentUri: uri }, { network: NETWORK });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionName,
              walletAddress: stored.walletAddress,
              agentId,
              agentUri: uri,
              status: result.status,
              ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
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

// erc8004_show — read-only: who owns an agent id, and what it claims to be.
tool(
  "erc8004_show",
  {
    title: "Read an ERC-8004 agent identity",
    description:
      "Read an ERC-8004 agent's on-chain owner and registration record by agent id. " +
      "Decodes the record when it is a base64 data URI (what this SDK and BNB Agent " +
      "Studio write); for an agent that published an https record instead, the raw " +
      "URI is returned for you to fetch. There is no reverse lookup — you need the id.",
    inputSchema: { agentId: z.string() },
  },
  async ({ agentId }: { agentId: string }) => {
    const { owner, agentUri } = await getErc8004Agent(NETWORK, BigInt(agentId));
    let registrationFile: unknown;
    let decodeError: string | undefined;
    try {
      registrationFile = decodeErc8004AgentUri(agentUri);
    } catch (e) {
      decodeError = (e as Error).message;
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { agentId, owner, agentUri, registrationFile, decodeError },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// ---------- skills registry (certified protocol playbooks) -----------------

// search_skills — keyword search over the Altana certified-skills registry.
tool(
  "search_skills",
  {
    title: "Find a certified skill",
    description:
      "Find certified protocol skills (trading, lending, payments) this " +
      "wallet's agent can use on chain. Call when the user asks to trade or " +
      "interact with a DeFi protocol (e.g. \"buy a token on PancakeSwap\"). " +
      "Returns matching skills with their scope and certification scorecard; " +
      "then call get_skill for the one you want to run.",
    inputSchema: { query: z.string() },
  },
  async ({ query }: { query: string }) => {
    const matches = await searchSkills(query);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              query,
              count: matches.length,
              matches,
              note:
                matches.length > 0
                  ? "Call get_skill with a match's id to fetch its verified SKILL.md playbook before acting."
                  : "No certified skills matched. Try broader terms (e.g. a protocol or action name).",
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

// get_skill — fetch one skill's verified SKILL.md playbook by id.
tool(
  "get_skill",
  {
    title: "Get a certified skill",
    description:
      "Fetch the full SKILL.md playbook for one certified skill by id (from " +
      "search_skills). The content is integrity-checked against the " +
      "registry's sha256 before being returned, so you can follow it to " +
      "operate the protocol. Also returns the skill's scope (allowed " +
      "contracts, suggested spend cap) and certification scorecard.",
    inputSchema: {
      id: z.string().describe("The skill id, e.g. \"pancakeswap-trading\""),
    },
  },
  async ({ id }: { id: string }) => {
    const skill = await getSkill(id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(skill, null, 2),
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
      "Explain what Altana Smart Agentic Wallet is and how it differs from other wallet stacks.",
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
            "- `/altana-agentic-wallet:wallet-balance` — Check a wallet's balance (native plus every token it holds)",
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
    description: "Check an Altana wallet's balances by name: native coin plus every token it holds.",
    argsSchema: { name: z.string().optional() },
  },
  ({ name }: { name?: string }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Call wallet_balance for wallet "${name ?? "default"}" with discover: true. ` +
            `Show the address, the native balance (balanceEth, in the chain's native coin), ` +
            `and one line per token with its symbol and display amount. ` +
            `If the tool errors because the chain has no relay, call it again without discover and show the native balance only.`,
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
