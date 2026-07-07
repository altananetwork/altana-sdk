/**
 * Reproduces the user's failing sync against the same L1Block anchor.
 * Surfaces the actual revert data (custom errors are decoded properly here).
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

const USER = "0x5db3f58a077a60975c51f2f752de6d00f9a3dfde" as const;
const PUBLIC_KEY =
  "0x04cfebe09b65b131f0daa898592bf266f31b867b3b92afb8fe730627654947239151de886c871859fb66bdb947ec565c0664e4b414d3027c4455872209029ec1cb" as const;

function loadKey(): Hex {
  const text = readFileSync(`${process.env.HOME}/.altana/keystore-base-sepolia-deployer.txt`, "utf8");
  const m = text.match(/Private key:\s+(0x[0-9a-fA-F]{64})/);
  if (!m) throw new Error("private key not found");
  return m[1] as Hex;
}

async function main() {
  const l1Client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA.publicRpcUrl) });
  const l2Client = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA.publicRpcUrl) });
  const l2WalletClient = createWalletClient({
    account: privateKeyToAccount(loadKey()),
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA.publicRpcUrl),
  });

  console.log("Calling syncKeyToL2 with the user's failing inputs...");
  try {
    const result = await syncKeyToL2({
      l1Client: l1Client as never,
      l2Client: l2Client as never,
      l2WalletClient: l2WalletClient as never,
      l1KeyStore: SEPOLIA.keyStore,
      l2Cache: BASE_SEPOLIA.keyStoreCache,
      user: USER,
      publicKey: PUBLIC_KEY,
    });
    console.log("Unexpected success:", result);
  } catch (err: any) {
    console.log("---- ERROR ----");
    console.log("name:", err?.name);
    console.log("shortMessage:", err?.shortMessage);
    console.log("metaMessages:", err?.metaMessages);
    console.log("cause.shortMessage:", err?.cause?.shortMessage);
    console.log("cause.data:", err?.cause?.data);
    console.log("cause.cause?.data:", err?.cause?.cause?.data);
    if (err?.details) console.log("details:", err.details);
  }
}

main();
