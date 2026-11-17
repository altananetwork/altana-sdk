/**
 * Where the shared testnet env file is.
 *
 * Live scripts append a throwaway wallet's key to it before sending that wallet
 * any funds, so a run that dies does not strand them. Which means getting the
 * path wrong is not a cosmetic bug: the key ends up in a file nobody looks in,
 * and the funds are lost in practice.
 *
 * A fixed `../../../.env.testnet` is wrong in a git worktree. The file sits
 * beside the repository, so from the main checkout three levels up from
 * `tests/e2e` is right, but a worktree lives two directories deeper
 * (`celo-harness/worktrees/<name>`) and the same path lands on
 * `celo-harness/worktrees/.env.testnet`, a file that does not exist and is
 * created empty. So look for the file instead of counting directories.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The shared testnet env file: `TESTNET_ENV_FILE` when set, otherwise the
 * nearest `.env.testnet` at or above this directory. Throws when there is
 * none, rather than creating one somewhere arbitrary.
 */
export function testnetEnvFile(): string {
  const override = process.env.TESTNET_ENV_FILE;
  if (override) return resolve(override);

  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, ".env.testnet");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "No .env.testnet found at or above tests/e2e. It lives beside the repository " +
      "(Altana-Ecosystem-Mainnet/.env.testnet); set TESTNET_ENV_FILE to point at it.",
  );
}
