/**
 * The agent identity a new wallet gets by itself.
 *
 * A wallet created with Altana is an agent's wallet, and ERC-8004 is where
 * agents are listed. Registering there used to be a step someone had to run,
 * so almost no wallet had an identity, and the ones that did carried whatever
 * record another platform wrote for them.
 *
 * So after a wallet's first admin action has confirmed, the SDK registers it
 * in the chain's ERC-8004 registry: one `register` call, in a transaction of
 * its own. The record is stored onchain and says "Altana Agent", with a link
 * to the wallet's page on the Altana explorer, unless the builder passes its
 * own name, description, image or link. Every such registration carries the
 * onchain tag `createdWith = altana`, which is how they are counted.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: a KeyStore registration never depends on
 * ERC-8004. The registration here is never part of the transaction that sets a
 * wallet up or registers a key. It is sent only after that transaction has
 * confirmed, and whatever happens to it (the registry refuses, the relay is
 * down, the wallet has nothing left to pay with) is reported as an outcome and
 * never thrown. `afterFirstAction` and `registerAgentIdentity` do not throw.
 *
 * It is on by default and always optional: `agentIdentity: false` on the
 * client, or on a single call, turns it off.
 */
import { toHex, type Address, type Hex } from "viem";
import type { NetworkConfig } from "./config.js";
import {
  ERC8004_ADDRESSES,
  encodeErc8004AgentUri,
  erc8004AgentCount,
  registerErc8004Agent,
  type Erc8004MetadataEntry,
  type Erc8004RegistrationFile,
} from "./erc8004.js";
import { clearFirstAction, hasFirstAction, noteRegistered } from "./internal/firstActions.js";
import { hasRawPrivateKey, type Signer } from "./internal/signer.js";
import type { Wallet } from "./internal/types.js";

/** What the public record says. Every field is optional; the defaults are Altana's. */
export type AgentIdentityRecord = {
  /** Shown as the agent's name. Default: "Altana Agent". */
  name?: string;
  /** One line about the agent. */
  description?: string;
  /** An image URL. Default: the Altana icon. */
  image?: string;
  /** Where the agent is reached or described. Default: the wallet's page on the Altana explorer. */
  endpoint?: string;
};

/**
 * `false` turns the automatic registration off. An object keeps it on and
 * replaces parts of the default record. Omitted, it is on with the defaults.
 */
export type AgentIdentityOption = false | AgentIdentityRecord;

/**
 * How the registration went. `agentId` is a decimal string so a result that
 * carries this still passes through `JSON.stringify`.
 */
export type AgentIdentityOutcome =
  | {
      status: "registered";
      chainId: number;
      registry: Address;
      agentId: string;
      callsId: Hex;
      transactionHash?: Hex;
    }
  | {
      status: "skipped";
      chainId: number;
      /**
       * `already-registered`: the wallet owns an agent already.
       * `passkey`: a passkey has to approve each transaction, so the SDK does
       * not send a second one by itself; call `registerAgentIdentity` when the
       * app chooses to ask.
       * `no-registry`: the chain has no ERC-8004 registry the SDK knows.
       */
      reason: "already-registered" | "passkey" | "no-registry";
    }
  | { status: "failed"; chainId: number; reason: string };

export const DEFAULT_AGENT_NAME = "Altana Agent";
export const DEFAULT_AGENT_DESCRIPTION =
  "A smart agentic wallet on Altana. Its keys and permissions are public in the Altana KeyStore.";
export const DEFAULT_AGENT_IMAGE = "https://docs.altana.network/altana-icon.png";

/**
 * The onchain tag every registration made here carries. It is written with
 * the registration itself (`register(agentURI, metadata)`), so the registry
 * emits it and anyone can count the agents created with Altana.
 */
export const ALTANA_AGENT_TAG: Erc8004MetadataEntry = {
  metadataKey: "createdWith",
  metadataValue: toHex("altana"),
};

const EXPLORER_URL = "https://explorer.altana.network";
const TESTNET_EXPLORER_URL = "https://testnet.altana.network";

/** The wallet's page on the Altana explorer: its keys and their permissions. */
export function altanaExplorerWalletUrl(network: NetworkConfig, wallet: Address): string {
  const base = network.chain.testnet ? TESTNET_EXPLORER_URL : EXPLORER_URL;
  return `${base}/account/${wallet}`;
}

/** How 8004scan names each chain in an agent's page address. Read from the site, 2026-11-18. */
const SCAN_CHAIN: Record<number, string> = {
  56: "bsc",
  97: "bsc-testnet",
  42220: "celo",
  11142220: "celo-sepolia",
};

/** The agent's public page on 8004scan, or undefined for a chain it does not list by a name the SDK knows. */
export function agentPageUrl(chainId: number, agentId: bigint | string): string | undefined {
  const chain = SCAN_CHAIN[chainId];
  return chain ? `https://8004scan.io/agents/${chain}/${agentId}` : undefined;
}

/** True when the SDK knows an ERC-8004 registry on this chain. */
export function hasAgentRegistry(chainId: number): boolean {
  return ERC8004_ADDRESSES[chainId] !== undefined;
}

/**
 * The record a wallet is registered with: Altana's defaults, with whatever the
 * builder passed laid over them. `registrations` is empty because the agent's
 * number does not exist until this record is registered; the record lives
 * onchain under that number, so the link between the two is the chain itself.
 */
export function agentIdentityFile(
  network: NetworkConfig,
  wallet: Address,
  record: AgentIdentityRecord = {},
): Erc8004RegistrationFile {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: record.name?.trim() || DEFAULT_AGENT_NAME,
    description: record.description?.trim() || DEFAULT_AGENT_DESCRIPTION,
    image: record.image?.trim() || DEFAULT_AGENT_IMAGE,
    services: [{ name: "web", endpoint: record.endpoint?.trim() || altanaExplorerWalletUrl(network, wallet) }],
    registrations: [],
  };
}

/** The chain reads and the one write this step makes. Tests pass fakes. */
export type AgentIdentityDeps = {
  /** How many agents `owner` holds in the chain's registry. */
  agentCount(network: NetworkConfig, owner: Address): Promise<bigint>;
  /** Send the registration and wait for it. Throws when it did not confirm. */
  register(
    wallet: Wallet,
    signer: Signer,
    params: { agentUri: string; metadata: readonly Erc8004MetadataEntry[] },
    opts: { network: NetworkConfig; feeToken?: Address | readonly Address[] },
  ): Promise<{ agentId: bigint; callsId: Hex; transactionHash?: Hex }>;
};

const REAL_DEPS: AgentIdentityDeps = {
  agentCount: erc8004AgentCount,
  register: (wallet, signer, params, opts) => registerErc8004Agent(wallet, signer, params, opts),
};

export type RegisterAgentIdentityOptions = {
  wallet: Wallet;
  /** The wallet's admin signer. A passkey signer prompts, as for any transaction. */
  signer: Signer;
  network: NetworkConfig;
  /** Parts of the record to replace. */
  identity?: AgentIdentityRecord;
  /** The relay fee token for this transaction; omitted, the relay charges a token the wallet holds. */
  feeToken?: Address | readonly Address[];
};

/**
 * Register a wallet's agent identity now. For a passkey wallet, which the
 * automatic step leaves alone, and for a wallet whose automatic registration
 * was skipped or failed. A wallet that owns an agent already is left as it is.
 *
 * Never throws: the outcome says what happened.
 */
export async function registerAgentIdentity(
  opts: RegisterAgentIdentityOptions,
  deps: AgentIdentityDeps = REAL_DEPS,
): Promise<AgentIdentityOutcome> {
  const chainId = opts.network.chainId;
  try {
    const registry = ERC8004_ADDRESSES[chainId];
    if (!registry) return { status: "skipped", chainId, reason: "no-registry" };

    if ((await deps.agentCount(opts.network, opts.wallet.address)) > 0n) {
      return { status: "skipped", chainId, reason: "already-registered" };
    }

    const file = agentIdentityFile(opts.network, opts.wallet.address, opts.identity);
    const sent = await deps.register(
      opts.wallet,
      opts.signer,
      { agentUri: encodeErc8004AgentUri(file), metadata: [ALTANA_AGENT_TAG] },
      { network: opts.network, ...(opts.feeToken ? { feeToken: opts.feeToken } : {}) },
    );
    return {
      status: "registered",
      chainId,
      registry,
      agentId: sent.agentId.toString(),
      callsId: sent.callsId,
      ...(sent.transactionHash ? { transactionHash: sent.transactionHash } : {}),
    };
  } catch (error) {
    return { status: "failed", chainId, reason: reasonOf(error) };
  }
}

export type AfterFirstActionArgs = {
  wallet: Wallet;
  signer: Signer;
  network: NetworkConfig;
  /** The caller's `agentIdentity` option. */
  option: AgentIdentityOption | undefined;
  /** How the admin action that just ran ended. */
  action: "confirmed" | "pending" | "failed";
  feeToken?: Address | readonly Address[];
};

/**
 * Run after an admin action. Registers the wallet's agent identity when that
 * action was the wallet's first and it confirmed; does nothing otherwise.
 *
 * Returns undefined when there is nothing to report: the action was not a
 * first action, it did not confirm, or the step is switched off.
 *
 * Never throws.
 */
export async function afterFirstAction(
  args: AfterFirstActionArgs,
  deps: AgentIdentityDeps = REAL_DEPS,
): Promise<AgentIdentityOutcome | undefined> {
  const chainId = args.network.chainId;
  try {
    const wallet = args.wallet.address;
    // No note: this was not the wallet's first action. Nothing is read.
    if (!hasFirstAction(chainId, wallet)) return undefined;
    // Still on its way: leave the note for the next confirmed action.
    if (args.action === "pending") return undefined;
    clearFirstAction(chainId, wallet);
    // The first action did not land, so the wallet is not set up. Its next
    // attempt is a first action again and notes itself.
    if (args.action !== "confirmed") return undefined;
    // The registration it carried is on chain. Remembered, so that the next
    // action does not ask a node that may not have seen that block yet and
    // carry the registration a second time.
    noteRegistered(chainId, wallet);

    if (args.option === false) return undefined;
    if (!hasAgentRegistry(chainId)) return undefined;
    if (!hasRawPrivateKey(args.signer)) return { status: "skipped", chainId, reason: "passkey" };

    return await registerAgentIdentity(
      {
        wallet: args.wallet,
        signer: args.signer,
        network: args.network,
        ...(args.option ? { identity: args.option } : {}),
        ...(args.feeToken ? { feeToken: args.feeToken } : {}),
      },
      deps,
    );
  } catch (error) {
    return { status: "failed", chainId, reason: reasonOf(error) };
  }
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.slice(0, 400);
}
