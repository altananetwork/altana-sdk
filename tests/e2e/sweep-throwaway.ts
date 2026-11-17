/**
 * Returns what is left in the throwaway wallets the live smokes saved to the shared testnet env
 * (SMOKE_THROWAWAY_*_KEY) to the funder, on Celo Sepolia, Base Sepolia and Sepolia.
 *
 * Run: set -a; source <ecosystem>/.env.testnet; set +a; bun run sweep-throwaway.ts
 */
import { createClient, quoteCalls, signerFromPrivateKey, BASE_SEPOLIA, CELO_SEPOLIA, SEPOLIA, type NetworkConfig } from "@altananetwork/sdk";
import { createClient as createViemClient, createPublicClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const funder = process.env.TEST_FUNDER_ADDRESS as `0x${string}`;
if (!funder) throw new Error("Load the shared testnet env first (TEST_FUNDER_ADDRESS).");
const rpc = (n: NetworkConfig, v?: string): NetworkConfig => (v ? { ...n, publicRpcUrl: v } : n);
const networks = [
  rpc(CELO_SEPOLIA, process.env.CELO_SEPOLIA_RPC_URL),
  rpc(BASE_SEPOLIA, process.env.BASE_SEPOLIA_RPC_URL),
  rpc(SEPOLIA, process.env.SEPOLIA_RPC_URL),
];
const keys = Object.entries(process.env).filter(([k]) => /^SMOKE_THROWAWAY_[0-9A-F]+_KEY$/.test(k));

for (const [name, key] of keys) {
  const admin = signerFromPrivateKey(key as Hex);
  const address = privateKeyToAccount(key as Hex).address;
  console.log(`${name.replace(/_KEY$/, "")} ${address}`);
  for (const n of networks) {
    const symbol = n.chain.nativeCurrency.symbol;
    try {
      const balance = await createPublicClient({ chain: n.chain, transport: http(n.publicRpcUrl) }).getBalance({ address });
      if (balance === 0n) {
        console.log(`  ${n.chain.name}: empty`);
        continue;
      }
      const relay = createViemClient({ chain: n.chain, transport: http(n.relayUrl!) });
      const opts = {
        feeToken: "0x0000000000000000000000000000000000000000" as const,
        submittingKey: { type: "secp256k1" as const, publicKey: admin.publicKey, role: "admin" as const },
        network: n,
      };
      // Size the transfer from the relay's own quote: everything but the fee and the registration
      // fee a first action prepends, with headroom.
      const probe = await quoteCalls(relay, address, admin, [{ to: funder, value: 1n, data: "0x" }], opts);
      const amount = balance - ((probe.nativeNeeded - 1n) * 13n) / 10n;
      if (amount <= 0n) {
        console.log(`  ${n.chain.name}: ${formatEther(balance)} ${symbol} left, below the transfer cost; kept`);
        continue;
      }
      const res = await createClient({ chains: [n] }).execute({ wallet: { address }, signer: admin, calls: { to: funder, value: amount, data: "0x" } });
      console.log(`  ${n.chain.name}: returned ${formatEther(amount)} ${symbol} (${res.status})`);
    } catch (err) {
      console.log(`  ${n.chain.name}: failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
    }
  }
}
