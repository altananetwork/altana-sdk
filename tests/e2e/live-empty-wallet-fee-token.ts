/**
 * LIVE (Celo Sepolia, via relay-staging) — an empty wallet is quoted in the
 * chain's NATIVE token, not in a stablecoin it has no way to get.
 *
 * Doris decided this on 2026-10-20 (MATRIX row 154,
 * `evidence/2026-09-28-empty-wallet-quoted-in-usdm.md`): left to the relay, a
 * wallet holding none of the fee tokens is quoted in USDm with `nativeNeeded`
 * 0, so the deficit names a token the faucet cannot supply and the one field a
 * "top up, then retry" flow reads says zero.
 *
 * The run proves both halves against the same relay:
 *   [before] the relay's own choice, asked directly over JSON-RPC with no fee
 *            token named — the behaviour the SDK used to pass through;
 *   [after]  what the SDK now quotes for the same wallet and the same call.
 *
 * Nothing is signed, nothing is sent and nothing is funded, so this costs
 * nothing and needs no funder: the wallet is counterfactual and stays empty,
 * which is the case under test.
 *
 *   bun run tests/e2e/live-empty-wallet-fee-token.ts
 *
 *   ALTANA_RELAY_URL        optional relay override
 *   CELO_SEPOLIA_RPC_URL    optional Celo read RPC
 */
import {
  CELO_SEPOLIA,
  createClient,
  feeCurrencies,
  quoteExecute,
  sdkBuild,
  signerFromPrivateKey,
  type NetworkConfig,
} from "@altananetwork/sdk";
import { numberToHex, type Address, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { writeFileSync } from "node:fs";

const RELAY = process.env.ALTANA_RELAY_URL ?? "https://relay-staging-production-2657.up.railway.app";

const network: NetworkConfig = {
  ...CELO_SEPOLIA,
  relayUrl: RELAY,
  ...(process.env.CELO_SEPOLIA_RPC_URL ? { publicRpcUrl: process.env.CELO_SEPOLIA_RPC_URL } : {}),
} as NetworkConfig;

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ok: ${msg}`);
}

const record: Record<string, unknown> = { relay: RELAY, startedAt: new Date().toISOString() };

/** One JSON-RPC call to the relay, returning `{ result }` or `{ error }`. */
async function relayCall(method: string, params: unknown[]): Promise<any> {
  const res = await fetch(RELAY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as any;
}

async function main() {
  console.log("LIVE: an empty wallet's fee token on Celo Sepolia");
  console.log("=================================================\n");
  // The script imports the BUILT package, so a stale dist silently proves the
  // wrong code. Print what is actually under test before anything else.
  console.log(`sdk build ${sdkBuild.describe}`);
  if (sdkBuild.describe.includes("dirty")) {
    console.log("  (dirty tree: run `bun run --cwd packages/wallet build` if you changed src since)");
  }
  record.sdkBuild = sdkBuild.describe;
  console.log(`relay ${RELAY}\n`);

  const { currencies } = await feeCurrencies({ network });
  console.log(`[0] the relay's fee tokens on chain ${network.chainId}`);
  for (const c of currencies) {
    console.log(`    ${c.isNative ? "native " : "       "}${c.symbol.padEnd(6)} ${c.address}`);
  }
  record.feeTokens = currencies.map((c) => ({ symbol: c.symbol, address: c.address, isNative: c.isNative }));
  const native = currencies.find((c) => c.isNative);
  assert(Boolean(native), "the relay accepts the native token as a fee token");
  assert(currencies.length > 1, `the relay offers more than one fee token (${currencies.length}), so there is a choice to get wrong`);

  // Counterfactual: this writes the relay's account record and nothing on
  // chain. The wallet holds nothing and is never funded.
  const signer = signerFromPrivateKey(generatePrivateKey());
  const client = createClient({ chains: [network] });
  const wallet = await client.createWallet({ signer });
  console.log(`\nwallet ${wallet.address} (fresh, counterfactual, never funded)`);
  record.wallet = wallet.address;

  const assets = await relayCall("wallet_getAssets", [
    { account: wallet.address, assetTypeFilter: ["native", "erc20"], chainFilter: [numberToHex(network.chainId)] },
  ]);
  const listed = (assets.result?.[numberToHex(network.chainId)] ?? []) as any[];
  const nonZero = listed.filter((a) => a.balance && BigInt(a.balance) > 0n);
  console.log(`    the relay lists ${listed.length} asset(s), ${nonZero.length} with a balance`);
  record.heldAssets = listed.map((a) => ({ address: a.address, balance: a.balance }));
  assert(nonZero.length === 0, "the relay sees this wallet holding nothing at all");

  const CALLS = [{ to: wallet.address as Address, value: 0n, data: "0x" as Hex }];

  console.log("\n[before] the relay's own choice, no fee token named (raw JSON-RPC)");
  const raw = await relayCall("wallet_prepareCalls", [
    {
      from: wallet.address,
      chainId: numberToHex(network.chainId),
      calls: CALLS.map((c) => ({ to: c.to, value: numberToHex(c.value), data: c.data })),
      capabilities: { meta: {} },
    },
  ]);
  if (raw.error) {
    console.log(`    the relay refused the unnamed request: ${JSON.stringify(raw.error).slice(0, 200)}`);
    record.before = { error: raw.error };
  } else {
    const quote = raw.result?.context?.quote?.quotes?.[0];
    const token = quote?.intent?.paymentToken as string | undefined;
    const symbol = currencies.find((c) => c.address.toLowerCase() === String(token).toLowerCase())?.symbol ?? "?";
    const deficits = (quote?.assetDeficits ?? []).map((d: any) => `${d.symbol ?? d.address}: ${d.required}`);
    console.log(`    paymentToken ${token} (${symbol})`);
    console.log(`    assetDeficits ${deficits.length ? deficits.join("; ") : "(none)"}`);
    record.before = { paymentToken: token, symbol, deficits };
    if (symbol !== (native!.symbol)) {
      console.log(`    ^ this is the behaviour Doris decided against: an empty wallet told to fund ${symbol}`);
    }
  }

  console.log("\n[after] what the SDK quotes for the same wallet and the same call");
  const q = await quoteExecute(wallet, signer, CALLS, { network });
  const symbol = currencies.find((c) => c.address.toLowerCase() === q.feeToken.toLowerCase())?.symbol ?? "?";
  console.log(`    feeToken        ${q.feeToken} (${symbol})`);
  console.log(`    fee             ${q.fee}`);
  console.log(`    feeTokenDeficit ${q.feeTokenDeficit}`);
  console.log(`    nativeNeeded    ${q.nativeNeeded} (${q.nativeNeededFromRelay ? "the relay's own figure" : "fee plus value"})`);
  record.after = {
    feeToken: q.feeToken,
    symbol,
    fee: q.fee.toString(),
    feeTokenDeficit: q.feeTokenDeficit.toString(),
    nativeNeeded: q.nativeNeeded.toString(),
    nativeNeededFromRelay: q.nativeNeededFromRelay,
  };

  assert(q.feeToken.toLowerCase() === native!.address.toLowerCase(), `the quote is in the native token (${native!.symbol}), not a stablecoin`);
  assert(q.nativeNeeded > 0n, `nativeNeeded is a real figure (${q.nativeNeeded} wei), so "top up, then retry" has something to read`);
  console.log(`\n    in words: fund this wallet with ${Number(q.nativeNeeded) / 1e18} ${native!.symbol}`);
}

main()
  .then(() => {
    record.verdict = "PASS";
    console.log("\n=================================================");
    console.log("Result: PASS — an empty wallet is quoted in the native token, with a non-zero nativeNeeded.");
  })
  .catch((err) => {
    record.verdict = "FAIL";
    record.error = err instanceof Error ? err.message : String(err);
    console.error(`\nResult: FAIL — ${record.error}`);
    process.exitCode = 1;
  })
  .finally(() => {
    const stamp = String(record.sdkBuild ?? "unknown").replace(/[^a-zA-Z0-9]/g, "");
    const path = new URL(`./empty-wallet-fee-token-run-${new Date().toISOString().slice(0, 10)}-${stamp}.json`, import.meta.url);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    console.log(`run record ${path.pathname.split("/").pop()}`);
  });
