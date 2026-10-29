/**
 * `~/.altana/link.json`: which wallet address the extension has connected this
 * machine's agent to.
 *
 * The native host writes it when the person clicks Connect, and the MCP reads it
 * on every call that needs to know whose wallet this is. It holds an address and
 * a chain, never a key: the key stays in the extension.
 *
 * Read on every call rather than cached at startup, because the extension can
 * link, unlink and relink while the agent is running, and an agent holding a
 * stale address would report somebody else's balance.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address } from "viem";
import { altanaHome } from "./keys.js";

export type Link = {
  v: 1;
  address: Address;
  chainId: number;
  linkedAt: string;
};

export function linkPath(): string {
  return join(altanaHome(), "link.json");
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The current link, or undefined if there is none.
 *
 * A malformed or half-written file reads as no link at all rather than throwing.
 * The caller's job when there is no link is to say "not connected yet, open the
 * extension", and that is the right answer for a corrupt file too: the person
 * fixes it by clicking Connect again, which is exactly what that message asks
 * for.
 */
export async function readLink(): Promise<Link | undefined> {
  try {
    const parsed = JSON.parse(await readFile(linkPath(), "utf8")) as Partial<Link>;
    if (typeof parsed.address !== "string" || !ADDRESS.test(parsed.address)) return undefined;
    if (typeof parsed.chainId !== "number" || !Number.isInteger(parsed.chainId)) return undefined;
    return {
      v: 1,
      address: parsed.address as Address,
      chainId: parsed.chainId,
      linkedAt: typeof parsed.linkedAt === "string" ? parsed.linkedAt : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

export class LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkError";
  }
}

/** Write the link. Validates before touching the disk, so a bad request leaves no file. */
export async function writeLink(args: { address: string; chainId: number }): Promise<Link> {
  const address = args.address?.trim();
  if (!address || !ADDRESS.test(address)) {
    throw new LinkError(
      "That is not an address. It has to be 0x followed by 40 hex characters.",
    );
  }
  if (!Number.isInteger(args.chainId) || args.chainId <= 0) {
    throw new LinkError(`chainId has to be a positive whole number, got ${String(args.chainId)}.`);
  }
  const link: Link = {
    v: 1,
    address: address as Address,
    chainId: args.chainId,
    linkedAt: new Date().toISOString(),
  };
  await mkdir(altanaHome(), { recursive: true, mode: 0o700 });
  // Same reason as the heartbeat files: the MCP reads this on every call, and a
  // reader that catches a half-written file would see no link and tell the
  // person to connect something that is already connected.
  const tmp = `${linkPath()}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(link, null, 2), { mode: 0o600 });
  await rename(tmp, linkPath());
  return link;
}

/** Remove the link. Idempotent: unlinking what is not linked is not an error. */
export async function clearLink(): Promise<void> {
  await unlink(linkPath()).catch(() => {});
}
