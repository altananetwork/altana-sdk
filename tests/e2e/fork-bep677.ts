/**
 * Fork test: prove client.balances applies BEP-677 scaled-UI-amount display
 * scaling end-to-end against a BSC fork — real multicall3, real ERC-165
 * detection, and a REAL non-ERC-165 token (USDT) exercising the
 * supportsInterface-revert path that unit tests can only simulate.
 *
 * Two stateless mocks are setCode'd onto the fork (runtime bytecode below):
 *  - Pending: uiMultiplier 1.5e18, newUIMultiplier 2e18, effectiveAt in 2100
 *    → display must use 1.5x and surface the pending change.
 *  - Elapsed: same but effectiveAt=1 (already effective) while uiMultiplier()
 *    lazily reports the old value → display must use the 2x newUIMultiplier.
 *
 * Run: bun tests/e2e/fork-bep677.ts
 *
 * Mock source (compiled with solc 0.8.28 --optimize --bin-runtime):
 *
 *   contract MockBEP677Pending {
 *     function balanceOf(address) external pure returns (uint256) { return 1000e18; }
 *     function decimals() external pure returns (uint8) { return 18; }
 *     function symbol() external pure returns (string memory) { return "sALT"; }
 *     function supportsInterface(bytes4 id) external pure returns (bool) {
 *       return id == 0xa60bf13d || id == 0x4bd27648;
 *     }
 *     function uiMultiplier() external pure returns (uint256) { return 1.5e18; }
 *     function newUIMultiplier() external pure returns (uint256) { return 2e18; }
 *     function effectiveAt() external pure returns (uint256) { return 4102444800; }
 *   }
 *   contract MockBEP677Elapsed { // identical except:
 *     function symbol() external pure returns (string memory) { return "sALT2"; }
 *     function effectiveAt() external pure returns (uint256) { return 1; }
 *   }
 */

import {
  createTestClient,
  createPublicClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { bsc } from "viem/chains";
import { createClient, BNB, UI_MULTIPLIER_ONE } from "@altananetwork/sdk";

const BSC_RPC = "https://bsc-rpc.publicnode.com";
const ANVIL_PORT = 8550;
const ANVIL_URL = `http://127.0.0.1:${ANVIL_PORT}`;

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const MOCK_PENDING: Address = "0x00000000000000000000000000000000000b6771";
const MOCK_ELAPSED: Address = "0x00000000000000000000000000000000000b6772";
const USDT_BSC: Address = "0x55d398326f99059ff775485246999027b3197955";

const MOCK_PENDING_RUNTIME: Hex =
  "0x608060405234801561000f575f5ffd5b506004361061007a575f3560e01c806395d89b411161005857806395d89b41146100df57806397a4064f14610105578063a60bf13d1461010f578063dc7670071461011d575f5ffd5b806301ffc9a71461007e578063313ce567146100a657806370a08231146100b5575b5f5ffd5b61009161008c366004610161565b61012b565b60405190151581526020015b60405180910390f35b6040516012815260200161009d565b6100d16100c336600461018f565b50683635c9adc5dea0000090565b60405190815260200161009d565b60408051808201825260048152631cd0531560e21b6020820152905161009d91906101b5565b63f48657006100d1565b6714d1120d7b1600006100d1565b671bc16d674ec800006100d1565b5f63a60bf13d60e01b6001600160e01b03198316148061015b575063097a4ec960e31b6001600160e01b03198316145b92915050565b5f60208284031215610171575f5ffd5b81356001600160e01b031981168114610188575f5ffd5b9392505050565b5f6020828403121561019f575f5ffd5b81356001600160a01b0381168114610188575f5ffd5b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f8301168401019150509291505056fea26469706673582212204998a643e1d20f5ac8ccc988ad5a60c0ffb12f3c9cd3189dd306871075ce946d64736f6c634300081c0033";

const MOCK_ELAPSED_RUNTIME: Hex =
  "0x608060405234801561000f575f5ffd5b506004361061007a575f3560e01c806395d89b411161005857806395d89b41146100df57806397a4064f14610106578063a60bf13d1461010d578063dc7670071461011b575f5ffd5b806301ffc9a71461007e578063313ce567146100a657806370a08231146100b5575b5f5ffd5b61009161008c36600461015f565b610129565b60405190151581526020015b60405180910390f35b6040516012815260200161009d565b6100d16100c336600461018d565b50683635c9adc5dea0000090565b60405190815260200161009d565b604080518082018252600581526439a0a62a1960d91b6020820152905161009d91906101b3565b60016100d1565b6714d1120d7b1600006100d1565b671bc16d674ec800006100d1565b5f63a60bf13d60e01b6001600160e01b031983161480610159575063097a4ec960e31b6001600160e01b03198316145b92915050565b5f6020828403121561016f575f5ffd5b81356001600160e01b031981168114610186575f5ffd5b9392505050565b5f6020828403121561019d575f5ffd5b81356001600160a01b0381168114610186575f5ffd5b602081525f82518060208401528060208501604085015e5f604082850101526040601f19601f8301168401019150509291505056fea26469706673582212206d0bbe5b5270937fe3ac4064fae4e1467613914702809e8cce31499fc9662de364736f6c634300081c0033";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function waitForAnvil(): Promise<void> {
  const probe = createPublicClient({ transport: http(ANVIL_URL) });
  for (let i = 0; i < 60; i++) {
    try {
      await probe.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("anvil did not become ready");
}

async function main() {
  console.log(`Forking BSC via anvil on ${ANVIL_URL} ...`);
  const proc = Bun.spawn(
    ["anvil", "--fork-url", BSC_RPC, "--port", String(ANVIL_PORT), "--silent"],
    { stdout: "ignore", stderr: "ignore" },
  );

  try {
    await waitForAnvil();
    const test = createTestClient({
      mode: "anvil",
      chain: bsc,
      transport: http(ANVIL_URL),
    });

    await test.setCode({ address: MOCK_PENDING, bytecode: MOCK_PENDING_RUNTIME });
    await test.setCode({ address: MOCK_ELAPSED, bytecode: MOCK_ELAPSED_RUNTIME });
    await test.setBalance({ address: OWNER, value: 5n * 10n ** 18n });

    // The SDK client pointed at the fork. BNB's chain def keeps multicall3,
    // which exists on the fork since it's a mainnet fork.
    const client = createClient({
      chains: [{ ...BNB, publicRpcUrl: ANVIL_URL }],
    });

    const res = await client.balances({
      wallet: OWNER,
      tokens: [MOCK_PENDING, MOCK_ELAPSED, USDT_BSC],
    });

    // Native path unchanged.
    assert(res.native === 5n * 10n ** 18n, `native = ${res.native}`);
    assert(res.tokens?.length === 3, "three token entries, order preserved");
    const [pendingTok, elapsedTok, usdt] = res.tokens!;

    // Mock 1: pending change in the future → current 1.5x multiplier applies.
    assert(pendingTok.ok, "pending mock readable");
    if (!pendingTok.ok) return;
    assert(pendingTok.symbol === "sALT", `symbol = ${pendingTok.symbol}`);
    assert(pendingTok.raw === 1000n * 10n ** 18n, `raw stays unscaled: ${pendingTok.raw}`);
    assert(pendingTok.display === "1500", `1.5x display = ${pendingTok.display}`);
    assert(
      pendingTok.scaled?.uiMultiplier === 15n * 10n ** 17n,
      `uiMultiplier = ${pendingTok.scaled?.uiMultiplier}`,
    );
    assert(
      pendingTok.scaled?.pending?.newUIMultiplier === 2n * UI_MULTIPLIER_ONE &&
        pendingTok.scaled?.pending?.effectiveAt === 4102444800n,
      "pending change surfaced",
    );
    console.log(`✓ pending mock: ${pendingTok.display} ${pendingTok.symbol} (×1.5, pending ×2)`);

    // Mock 2: effectiveAt elapsed → the 2x newUIMultiplier applies, no pending.
    assert(elapsedTok.ok, "elapsed mock readable");
    if (!elapsedTok.ok) return;
    assert(elapsedTok.display === "2000", `2x display = ${elapsedTok.display}`);
    assert(
      elapsedTok.scaled?.uiMultiplier === 2n * UI_MULTIPLIER_ONE,
      `elapsed multiplier = ${elapsedTok.scaled?.uiMultiplier}`,
    );
    assert(elapsedTok.scaled?.pending === undefined, "no pending after switch");
    console.log(`✓ elapsed mock: ${elapsedTok.display} ${elapsedTok.symbol} (×2 applied)`);

    // Real USDT: no ERC-165 at all — supportsInterface reverts on-chain and
    // the token must come back readable and UNscaled.
    assert(usdt.ok, "USDT readable");
    if (!usdt.ok) return;
    assert(usdt.symbol.length > 0, "USDT symbol non-empty");
    assert(usdt.decimals === 18, `USDT decimals = ${usdt.decimals}`);
    assert(usdt.scaled === undefined, "USDT is not scaled");
    console.log(`✓ real USDT: ${usdt.display} ${usdt.symbol} (unscaled)`);

    console.log("PASS: BEP-677 scaled display verified on BSC fork");
  } finally {
    proc.kill();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
