/**
 * Smoke test for the new @altananetwork/sdk syncKeyToL2 export.
 *
 * Reuses the known-active key on Sepolia KeyStore and submits a real
 * populateKey via the SDK helper. Identical end-state to submitPopulate.ts,
 * but exercising the SDK code path instead of inline script logic.
 *
 * Run with:
 *   cd /Users/dor1s/Documents/sdk && \
 *     bun run /Users/dor1s/Documents/Keystore/script/cache/testSyncSDK.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { syncKeyToL2, SEPOLIA, BASE_SEPOLIA } from "@altananetwork/sdk";

const USER = "0x38fa4f03cb1a6317dcdb9a8cffddb8dc8e89d04d" as const;
const PUBLIC_KEY =
  "0x047943be702771d0b32bc8739c85897d76d910424d37b78af5eb30443ff2334f2df06cfc5273162737d9f871bc81b5a44680e9f8eb087cd11d30b00f8ed2ccd4a5" as const;

function loadKey(): Hex {
  const text = readFileSync(`${process.env.HOME}/.altana/keystore-base-sepolia-deployer.txt`, "utf8");
  const m = text.match(/Private key:\s+(0x[0-9a-fA-F]{64})/);
  if (!m) throw new Error("private key not found");
  return m[1] as Hex;
}

async function main() {
  const l1Client = createPublicClient({
    chain: sepolia,
    transport: http(SEPOLIA.publicRpcUrl),
  });
  const l2Client = createPublicClient({
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA.publicRpcUrl),
  });
  const l2WalletClient = createWalletClient({
    account: privateKeyToAccount(loadKey()),
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA.publicRpcUrl),
  });

  console.log("Submitting via SDK syncKeyToL2()…");
  const result = await syncKeyToL2({
    l1Client: l1Client as never,
    l2Client: l2Client as never,
    l2WalletClient: l2WalletClient as never,
    l1KeyStore: SEPOLIA.keyStore,
    l2Cache: BASE_SEPOLIA.keyStoreCache,
    user: USER,
    publicKey: PUBLIC_KEY,
  });

  console.log("Tx hash:", result.txHash);
  console.log(`Basescan: https://sepolia.basescan.org/tx/${result.txHash}`);
  console.log("Cached state:");
  console.log("  publicKey:", result.cachedKey.publicKey);
  console.log("  active:", result.cachedKey.active);
  console.log("  sourceBlockHash:", result.cachedKey.sourceBlockHash);
  console.log("  sourceBlockNumber:", result.cachedKey.sourceBlockNumber);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
