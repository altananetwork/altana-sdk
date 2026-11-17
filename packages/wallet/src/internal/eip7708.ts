/**
 * Drop the EIP-7708 system address from a relay response's `assetDiffs`,
 * before porto validates it.
 *
 * Ethereum Sepolia activated Glamsterdam/EIP-7708 at block 11856337
 * (2026-10-06 13:53:36 UTC). Every ETH transfer now also emits a real ERC-20
 * `Transfer` log from `0xff..fe` (`SYSTEM_ADDRESS`). The relay builds
 * `assetDiffs` from simulation logs, so that log becomes
 * `{"address":"0xff..fe","type":"erc20","value":…}` — with no `symbol`,
 * because `0xff..fe` has no code and the relay's `decimals()`/`symbol()`/
 * `name()` multicall reverts.
 *
 * Every variant of porto's `AssetDiffAsset` union requires `symbol: string`,
 * so that entry matches none of them and porto 0.2.37 rejects the **whole**
 * response ("Validation failed with 3 errors"). Every `grantSession` registry
 * leg on Sepolia fails as a result.
 *
 * **Dropped, not relabelled, and that is the whole point.** The relay
 * synthesises its own native log from `0xee..ee`, so a post-fork transfer
 * produces *two* logs for one movement and the native diff already covers it
 * (measured in `celo-harness/evidence/2026-10-06-eip7708-asset-diff-proposal.md`).
 * Mapping `0xff..fe` onto the native asset would double every ETH balance
 * change — a silently wrong number in place of a loud validation error.
 *
 * This is a client-side mask, not a fix: it repairs clients on this SDK only,
 * and third-party or direct porto users still break until the relay skips the
 * log in `AssetDiffsBuilder::from_logs`.
 */

/** `SYSTEM_ADDRESS`, the sender EIP-7708 attributes native transfers to. */
export const EIP7708_SYSTEM_ADDRESS = "0xfffffffffffffffffffffffffffffffffffffffe";

function isSystemAddress(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === EIP7708_SYSTEM_ADDRESS;
}

/**
 * One chain's diffs: `[[account, [diff, …]], …]`. An entry whose only diff was
 * the system address is removed with it, so no account is reported with an
 * empty list.
 */
function sanitizeChain(entries: unknown): unknown {
  if (!Array.isArray(entries)) return entries;
  const kept: unknown[] = [];
  let changed = false;
  for (const entry of entries) {
    // Each entry is a [address, diffs] tuple; anything else is left untouched.
    if (!Array.isArray(entry) || entry.length < 2 || !Array.isArray(entry[1])) {
      kept.push(entry);
      continue;
    }
    const before = entry[1] as unknown[];
    const diffs = before.filter(
      (d) => !(typeof d === "object" && d !== null && isSystemAddress((d as { address?: unknown }).address)),
    );
    if (diffs.length === before.length) {
      kept.push(entry);
      continue;
    }
    changed = true;
    if (diffs.length === 0) continue;
    kept.push([entry[0], diffs, ...entry.slice(2)]);
  }
  return changed ? kept : entries;
}

/** `{ [chainIdHex]: [[account, [diff, …]], …] }` with the system entries gone. */
function sanitizeAssetDiffs(assetDiffs: unknown): unknown {
  if (typeof assetDiffs !== "object" || assetDiffs === null || Array.isArray(assetDiffs)) return assetDiffs;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [chainId, entries] of Object.entries(assetDiffs as Record<string, unknown>)) {
    const next = sanitizeChain(entries);
    if (next !== entries) changed = true;
    out[chainId] = next;
  }
  // Returned by identity when nothing was dropped: this runs on every relay
  // response, and a response without a 7708 entry should cost nothing.
  return changed ? out : assetDiffs;
}

/**
 * Walks a relay result and sanitizes every `assetDiffs` it carries.
 *
 * Keyed on the field name rather than on a per-method path, because **two**
 * methods carry it today — `wallet_prepareCalls` at
 * `result.capabilities.assetDiffs`, and `wallet_getCallsHistory` at
 * `result[i].capabilities.assetDiffs` — and a third gaining it should not need
 * another change here. Nothing else is touched: a value is only rewritten when
 * it sits under the key `assetDiffs`, and within it only objects carrying the
 * system address are removed.
 */
export function stripEip7708AssetDiffs<T>(result: T): T {
  if (Array.isArray(result)) {
    let changedHere = false;
    const mapped = result.map((v) => {
      const next = stripEip7708AssetDiffs(v);
      if (next !== v) changedHere = true;
      return next;
    });
    return (changedHere ? mapped : result) as unknown as T;
  }
  if (typeof result !== "object" || result === null) return result;
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result as Record<string, unknown>)) {
    const next = key === "assetDiffs" ? sanitizeAssetDiffs(value) : stripEip7708AssetDiffs(value);
    if (next !== value) changed = true;
    out[key] = next;
  }
  return (changed ? out : result) as T;
}
