import { describe, expect, test } from "bun:test";
import { parseEther, parseUnits, type Hex } from "viem";
import {
  EXPECTED,
  MAINNET_CENT_RECIPIENT,
  MAINNET_FLAG,
  MAINNET_PHRASE,
  UsageError,
  assertCanConfirm,
  assertCentRecipient,
  assertIdentity,
  chargeReport,
  convert,
  decodeIntents,
  describeError,
  estimateRegistration,
  firstStepNotDone,
  isConfirmed,
  isInsufficientFunds,
  oneCentIn,
  overBps,
  parseProofArgs,
  redact,
  stepsFor,
  summaryTable,
  sweepAmount,
  usdText,
  usdValue,
  type UsdPrice,
} from "./celo-proof-lib.js";
import registryIntent from "./fixtures/registry-intent-sepolia.json" with { type: "json" };

const RETURN_TO = "0x1111111111111111111111111111111111111111";
const usd = (text: string): UsdPrice => ({ answer: parseUnits(text, 8), decimals: 8 });

describe("parseProofArgs", () => {
  const sepoliaSend = ["--network", "celo-sepolia", "--wallet", "usdc", "--send"];
  const mainnetSend = ["--network", "celo", "--wallet", "celo", "--send", MAINNET_FLAG];

  test("with only a network it is a dry run of both wallets", () => {
    const o = parseProofArgs(["--network", "celo"]);

    expect(o.send).toBe(false);
    expect(o.network).toBe("celo");
    expect(o.wallet).toBeUndefined();
    expect(o.sweepTo).toBeUndefined();
  });

  test("a network is required and must be one of the two", () => {
    expect(() => parseProofArgs([])).toThrow(UsageError);
    expect(() => parseProofArgs(["--network", "mainnet"])).toThrow(/celo or celo-sepolia/);
  });

  test("--send on mainnet is refused without the literal owner flag", () => {
    expect(() => parseProofArgs(["--network", "celo", "--wallet", "celo", "--send"])).toThrow(
      /Refusing to send on Celo mainnet without --i-am-doris/,
    );
  });

  test("--send on mainnet with the owner flag is accepted, for one wallet", () => {
    const o = parseProofArgs(mainnetSend);

    expect(o.send).toBe(true);
    expect(o.wallet).toBe("celo");
  });

  test("the owner flag alone sends nothing", () => {
    expect(parseProofArgs(["--network", "celo", MAINNET_FLAG]).send).toBe(false);
  });

  test("a send runs one wallet: --wallet is required with --send", () => {
    expect(() => parseProofArgs(["--network", "celo-sepolia", "--send"])).toThrow(/one wallet at a time/);
    expect(() => parseProofArgs(["--network", "celo", "--send", MAINNET_FLAG])).toThrow(/one wallet at a time/);
    expect(() => parseProofArgs(["--network", "celo", "--wallet", "both"])).toThrow(/--wallet must be celo or usdc/);
  });

  test("--send on the testnet needs no owner flag", () => {
    expect(parseProofArgs(sepoliaSend).send).toBe(true);
  });

  test("nothing is swept unless --sweep-to names an address", () => {
    expect(parseProofArgs(mainnetSend).sweepTo).toBeUndefined();
    expect(parseProofArgs([...mainnetSend, "--sweep-to", RETURN_TO]).sweepTo).toBe(RETURN_TO);
    expect(() => parseProofArgs(["--network", "celo", "--sweep-to", RETURN_TO])).toThrow(/only means something with --send/);
  });

  test("the addresses a run sends to must be real ones", () => {
    for (const flag of ["--send-cent-to", "--sweep-to"]) {
      expect(() => parseProofArgs([...sepoliaSend, flag, "0x1234"])).toThrow(/not an address/);
      expect(() => parseProofArgs([...sepoliaSend, flag, "0x0000000000000000000000000000000000000000"])).toThrow(/not an address/);
    }
    expect(parseProofArgs(["--network", "celo", "--send-cent-to", RETURN_TO]).sendCentTo).toBe(RETURN_TO);
  });

  test("a misspelled flag is an error, never a silent dry run", () => {
    expect(() => parseProofArgs(["--network", "celo", "--sned"])).toThrow(/Unknown argument --sned/);
    expect(() => parseProofArgs(["--network", "celo", "send"])).toThrow(/Unknown argument send/);
  });

  test("flags that only act on a send are refused on a dry run", () => {
    for (const flag of ["--resume", "--discard-session"]) {
      expect(() => parseProofArgs(["--network", "celo", flag])).toThrow(/only means something with --send/);
    }
  });

  test("throwaway wallets and their funding are for the testnet only", () => {
    expect(() => parseProofArgs([...mainnetSend, "--fresh"])).toThrow(/only exist on celo-sepolia/);
    expect(() => parseProofArgs(["--network", "celo", "--fund-celo", "5"])).toThrow(/does nothing on celo/);
    expect(parseProofArgs([...sepoliaSend, "--fund-usdc", "9.5"])).toMatchObject({ fundCelo: "3", fundUsdc: "9.5" });
  });

  test("--resume cannot be combined with starting over", () => {
    expect(() => parseProofArgs([...sepoliaSend, "--resume", "--discard-session"])).toThrow(/cannot be combined/);
  });

  test("--from names the step a resumed run starts at", () => {
    expect(parseProofArgs([...sepoliaSend, "--resume", "--from", "revoke"]).from).toBe("revoke");
    expect(() => parseProofArgs([...sepoliaSend, "--from", "revoke"])).toThrow(/needs --resume/);
    expect(() => parseProofArgs([...sepoliaSend, "--resume", "--from", "grant"])).toThrow(/--from must be one of/);
    expect(() => parseProofArgs([...sepoliaSend, "--resume", "--from", "refund"])).toThrow(/--from must be one of/);
    expect(() => parseProofArgs([...sepoliaSend, "--resume", "--from", "sweep"])).toThrow(/needs --sweep-to/);
  });

  test("a value flag without a value, or given twice, is an error", () => {
    expect(() => parseProofArgs(["--network"])).toThrow(/needs a value/);
    expect(() => parseProofArgs(["--network", "celo", "--wallet", "--send"])).toThrow(/needs a value/);
    expect(() => parseProofArgs(["--network", "celo", "--network", "celo-sepolia"])).toThrow(/given twice/);
  });
});

describe("where the session's one cent goes", () => {
  const wallets = { celo: "0x887EAF32db5328Bd3F442747089985dA72474Bb8", usdc: "0x176F4C8Ca457cA5B13F4a3B11918315F4DDf9d0e" } as const;

  test("the mainnet default is the owner's deployer, and it is neither test wallet", () => {
    expect(MAINNET_CENT_RECIPIENT).toBe("0x90052C7827475fCAb79089B81ea928A9Fa19BE7C");
    expect(() => assertCentRecipient(MAINNET_CENT_RECIPIENT, wallets, "celo")).not.toThrow();
    expect(() => assertCentRecipient(MAINNET_CENT_RECIPIENT, wallets, "usdc")).not.toThrow();
  });

  test("it cannot be the wallet itself", () => {
    expect(() => assertCentRecipient(wallets.celo, wallets, "celo")).toThrow(/cannot go to the wallet itself/);
    expect(() => assertCentRecipient(wallets.usdc.toLowerCase() as `0x${string}`, wallets, "usdc")).toThrow(/cannot go to the wallet itself/);
  });

  test("it cannot be the other test wallet, which must stay free of CELO", () => {
    expect(() => assertCentRecipient(wallets.usdc, wallets, "celo")).toThrow(/other test wallet/);
    expect(() => assertCentRecipient(wallets.celo, wallets, "usdc")).toThrow(/other test wallet/);
  });
});

describe("a step the wallet cannot pay for", () => {
  test("is recognised by the SDK's code, on the error or under it", () => {
    const funds = Object.assign(new Error("Not enough USDC to pay for this: you have 2.2 USDC."), { code: "insufficient_funds" });

    expect(isInsufficientFunds(funds)).toBe(true);
    expect(isInsufficientFunds(Object.assign(new Error("Session revoke did not confirm on chain 42220"), { cause: funds }))).toBe(true);
    expect(isInsufficientFunds(Object.assign(new Error("wrapped"), { code: "unknown", cause: { code: "insufficient_funds" } }))).toBe(true);
  });

  test("is recognised by the SDK's sentence when only the sentence is left", () => {
    expect(
      isInsufficientFunds(new Error("the KeyStore registration is FAILED: Not enough S-CELO to pay for registering this key on Sepolia: you have 2.8 S-CELO.")),
    ).toBe(true);
    expect(isInsufficientFunds("Not enough USD₮ to pay for this: you have 0 USD₮.")).toBe(true);
  });

  test("any other failure is not", () => {
    expect(isInsufficientFunds(new Error("the relay answered HTTP 502"))).toBe(false);
    expect(isInsufficientFunds(Object.assign(new Error("The quote ran out."), { code: "quote_expired" }))).toBe(false);
    expect(isInsufficientFunds(undefined)).toBe(false);
  });
});

describe("a mainnet send is confirmed by a person", () => {
  const mainnetSend = parseProofArgs(["--network", "celo", "--wallet", "celo", "--send", MAINNET_FLAG]);

  test("without a terminal it is refused, owner flag or not", () => {
    expect(() => assertCanConfirm(mainnetSend, false)).toThrow(/interactive terminal/);
  });

  test("with a terminal it may go on to the typed confirmation", () => {
    expect(() => assertCanConfirm(mainnetSend, true)).not.toThrow();
  });

  test("a dry run and a testnet send need no terminal", () => {
    expect(() => assertCanConfirm(parseProofArgs(["--network", "celo"]), false)).not.toThrow();
    expect(() =>
      assertCanConfirm(parseProofArgs(["--network", "celo-sepolia", "--wallet", "celo", "--send"]), false),
    ).not.toThrow();
  });

  test("only the exact phrase confirms", () => {
    expect(isConfirmed(MAINNET_PHRASE)).toBe(true);
    expect(isConfirmed(`  ${MAINNET_PHRASE}\n`)).toBe(true);
    expect(isConfirmed("yes")).toBe(false);
    expect(isConfirmed("")).toBe(false);
    expect(isConfirmed("send on celo")).toBe(false);
  });
});

describe("assertIdentity", () => {
  test("accepts the two networks as the SDK defines them", () => {
    expect(() => assertIdentity("celo", { ...EXPECTED.celo })).not.toThrow();
    expect(() => assertIdentity("celo-sepolia", { ...EXPECTED["celo-sepolia"] })).not.toThrow();
  });

  test("a celo run on any other chain id is refused", () => {
    expect(() => assertIdentity("celo", { ...EXPECTED.celo, chainId: 11142220 })).toThrow(/must be chain 42220/);
  });

  test("a celo run against any other relay is refused", () => {
    expect(() => assertIdentity("celo", { ...EXPECTED.celo, relayUrl: "https://testnet-relay.altana.network" })).toThrow(
      /must use the relay https:\/\/relay\.altana\.network/,
    );
    expect(() => assertIdentity("celo", { chainId: 42220, registryChainId: 1 })).toThrow(/must use the relay/);
  });

  test("a testnet run pointed at the mainnet relay is refused", () => {
    expect(() => assertIdentity("celo-sepolia", { ...EXPECTED["celo-sepolia"], relayUrl: EXPECTED.celo.relayUrl })).toThrow(
      /must use the relay/,
    );
  });

  test("the KeyStore chain must be the expected one", () => {
    expect(() => assertIdentity("celo", { ...EXPECTED.celo, registryChainId: 11155111 })).toThrow(/KeyStore on chain 1/);
  });
});

describe("redact", () => {
  test("a provider URL is removed, a public one is kept", () => {
    const text = "failed at https://celo-mainnet.core.example.com/abc123secret and https://relay.altana.network";

    expect(redact(text)).toBe("failed at <rpc> and https://relay.altana.network");
  });

  test("a secret passed in is removed wherever it appears", () => {
    expect(redact("key 0xabcdef0123456789 leaked", ["0xabcdef0123456789"])).toBe("key <redacted> leaked");
  });

  test("a lookalike host is not treated as public", () => {
    expect(redact("https://altana.network.evil.example/x")).toBe("<rpc>");
  });
});

describe("describeError", () => {
  test("keeps the code, the detail and every cause of an SDK error", () => {
    const root = new Error("quote has asset deficits");
    const transport = Object.assign(new Error("RPC Request failed.\nURL: https://private.example/key"), { cause: root });
    const err = Object.assign(new Error("Not enough CELO to pay for this."), {
      name: "AltanaError",
      code: "insufficient_funds",
      detail: "asked https://private.example/key for a quote",
      cause: transport,
    });

    const d = describeError(err);

    expect(d.name).toBe("AltanaError");
    expect(d.code).toBe("insufficient_funds");
    expect(d.message).toBe("Not enough CELO to pay for this.");
    expect(d.detail).toBe("asked <rpc> for a quote");
    expect(d.causes).toEqual(["Error: RPC Request failed.", "Error: quote has asset deficits"]);
  });

  test("a thrown string is still described", () => {
    expect(describeError("boom")).toEqual({ name: "string", message: "boom", causes: [] });
  });
});

describe("firstStepNotDone", () => {
  test("nothing done starts at the grant", () => {
    expect(firstStepNotDone({})).toBe("grant");
  });

  test("a step that was not run for lack of funds is tried again", () => {
    expect(firstStepNotDone({ grant: "PASS", execute: "PASS", register: "NOT RUN", mirror: "NOT RUN", charge: "PASS" })).toBe("register");
  });

  test("the sweep is a step only when somewhere to sweep to was named", () => {
    expect(stepsFor({})).not.toContain("sweep");
    expect(stepsFor({ sweepTo: RETURN_TO })).toContain("sweep");
    const allButSweep = { grant: "PASS", execute: "PASS", register: "PASS", mirror: "PASS", charge: "PASS", revoke: "PASS", "revoke-mirror": "PASS" } as const;
    expect(firstStepNotDone(allButSweep, stepsFor({}))).toBeUndefined();
    expect(firstStepNotDone(allButSweep, stepsFor({ sweepTo: RETURN_TO }))).toBe("sweep");
  });

  test("it continues after the last step that passed", () => {
    expect(firstStepNotDone({ grant: "PASS", execute: "PASS" })).toBe("register");
  });

  test("a failed step is the one to retry", () => {
    expect(firstStepNotDone({ grant: "PASS", execute: "PASS", register: "FAIL" })).toBe("register");
  });

  test("a finished run has nothing left", () => {
    expect(
      firstStepNotDone({
        grant: "PASS",
        execute: "PASS",
        register: "PASS",
        mirror: "PASS",
        charge: "PASS",
        revoke: "PASS",
        "revoke-mirror": "PASS",
        sweep: "PASS",
      }),
    ).toBeUndefined();
  });
});

describe("summaryTable", () => {
  test("one aligned line per step, the link last", () => {
    const lines = summaryTable([
      { wallet: "celo", step: "grant", chain: "Celo", link: "https://celoscan.io/tx/0xaa", seconds: 12.34, status: "PASS" },
      { wallet: "usdc", step: "register (root)", chain: "Ethereum", link: "", status: "FAIL", note: "not enough USDC" },
    ]);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^wallet\s+step\s+chain\s+t\s+result\s+transaction \/ note$/);
    expect(lines[2]).toBe("celo    grant            Celo      12.3s  PASS    https://celoscan.io/tx/0xaa");
    expect(lines[3]).toBe("usdc    register (root)  Ethereum         FAIL    not enough USDC");
  });
});

describe("amounts", () => {
  test("one cent of CELO at $0.06708 is about 0.149 CELO", () => {
    expect(oneCentIn(usd("0.06708"), 18)).toBe(parseEther("0.01") * 100_000_000n / 6_708_000n);
  });

  test("one cent of USDC at $1 is 10000 base units", () => {
    expect(oneCentIn(usd("1"), 6)).toBe(10_000n);
  });

  test("convert prices one asset in another, across decimals", () => {
    const eth = { decimals: 18, price: usd("2000") };
    const usdc = { decimals: 6, price: usd("1") };
    const celo = { decimals: 18, price: usd("0.05") };

    expect(convert(parseEther("0.001"), eth, usdc)).toBe(2_000_000n);
    expect(convert(parseEther("0.001"), eth, celo)).toBe(parseEther("40"));
    expect(convert(2_000_000n, usdc, eth)).toBe(parseEther("0.001"));
  });

  test("overBps is how far one amount is above another", () => {
    expect(overBps(102n, 100n)).toBe(200);
    expect(overBps(100n, 100n)).toBe(0);
    expect(overBps(99n, 100n)).toBe(-100);
  });

  test("dollars are read off a price, and small amounts keep their digits", () => {
    expect(usdValue(parseEther("31"), 18, usd("0.064"))).toBeCloseTo(1.984, 6);
    expect(usdValue(2_200_000n, 6, usd("0.99976346"))).toBeCloseTo(2.19948, 5);
    expect(usdText(1.984)).toBe("$1.98");
    expect(usdText(0.0094)).toBe("$0.0094");
  });

  test("a sweep keeps the quoted fee with headroom, and sends nothing when that is all there is", () => {
    expect(sweepAmount(1_000n, 100n)).toBe(875n);
    expect(sweepAmount(1_000n, 100n, 0)).toBe(900n);
    expect(sweepAmount(120n, 100n)).toBe(0n);
  });
});

describe("estimateRegistration", () => {
  // Live figures of 2026-11-14: fee 0.00026299 ETH per key, base fee 0.11 gwei, ETH $1915, CELO $0.064.
  const live = {
    registrationFee: parseEther("0.00026299"),
    baseFeePerGas: 110_000_000n,
    priorityFeePerGas: 5_000n,
    native: { decimals: 18, price: usd("1915") },
    marginBps: 200,
  };
  const celo = { decimals: 18, price: usd("0.064") };

  test("a first registration at today's gas is about $1.8, some 28 CELO", () => {
    const e = estimateRegistration({ ...live, firstTime: true, token: celo });

    expect(e.usd).toBeGreaterThan(1.6);
    expect(e.usd).toBeLessThan(2.0);
    expect(e.lock).toBeGreaterThan(parseEther("25"));
    expect(e.lock).toBeLessThan(parseEther("31"));
  });

  test("the root key's write is what the relay quoted for it that day", () => {
    // The relay's quote for the root key's write at a 0.1243 gwei base fee: 0.000482376 ETH fronted.
    const rootOnly =
      estimateRegistration({ ...live, baseFeePerGas: 124_292_070n, registrationFee: 261_096_475_933_501n, firstTime: true, token: celo }).fronted -
      estimateRegistration({ ...live, baseFeePerGas: 124_292_070n, registrationFee: 261_096_475_933_501n, firstTime: false, token: celo }).fronted;

    expect(rootOnly).toBeGreaterThan(parseEther("0.000482"));
    expect(rootOnly).toBeLessThan(parseEther("0.000482") * 105n / 100n);
  });

  test("a later registration is one write, under half of a first one", () => {
    const first = estimateRegistration({ ...live, firstTime: true, token: celo });
    const later = estimateRegistration({ ...live, firstTime: false, token: celo });

    expect(later.fronted * 2n).toBeLessThan(first.fronted);
  });

  test("in USDC the same registration is the same dollars", () => {
    const inCelo = estimateRegistration({ ...live, firstTime: true, token: celo });
    const inUsdc = estimateRegistration({ ...live, firstTime: true, token: { decimals: 6, price: usd("1") } });

    expect(inUsdc.usd).toBeCloseTo(inCelo.usd, 2);
    expect(inUsdc.lock).toBeGreaterThan(1_600_000n);
    expect(inUsdc.lock).toBeLessThan(2_000_000n);
  });

  test("it rises with the gas price", () => {
    const calm = estimateRegistration({ ...live, firstTime: true, token: celo });
    const busy = estimateRegistration({ ...live, baseFeePerGas: 1_000_000_000n, firstTime: true, token: celo });

    expect(busy.lock).toBeGreaterThan(calm.lock * 2n);
  });
});

describe("decodeIntents", () => {
  test("reads the fee and what the funder fronted from a real relayed registry write", () => {
    const [intent, ...rest] = decodeIntents(registryIntent.input as Hex);

    expect(rest).toHaveLength(0);
    expect(intent!.eoa).toBe("0xF5469360E3C6793B0155d0Cf49e7b0CD93d9A48a");
    expect(intent!.paymentToken).toBe("0x0000000000000000000000000000000000000000");
    expect(intent!.paymentAmount).toBe(159_767_957_516_444n);
    expect(intent!.paymentMaxAmount).toBe(207_698_394_618_963n);
    expect(intent!.funded).toEqual([{ token: "0x0000000000000000000000000000000000000000", amount: 412_585_586_350_830n }]);
    expect(intent!.funder).toBe("0xb248602EAadd9c3e2Db4575C4e4d58003b7a2740");
  });

  test("refuses calldata that is not a relay transaction", () => {
    expect(() => decodeIntents("0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111")).toThrow();
  });
});

describe("chargeReport", () => {
  // The CELO-paid registration of the 2026-11-10 mainnet fork rehearsal: two
  // writes, 81.548572 CELO locked, Chainlink ETH/USD 2,068.82425549 and
  // CELO/USD 0.06708. The relay's rate there was Chainlink plus 2%, exactly.
  const eth = { symbol: "ETH", decimals: 18, price: usd("2068.82425549") };
  const celo = { symbol: "CELO", decimals: 18, price: usd("0.06708") };
  const forkWrites = [
    {
      kind: "root" as const,
      gasUsed: 608_035n,
      effectiveGasPrice: 473_300_000n,
      registrationFee: parseEther("0.000241683"),
      fronted: parseEther("0.001538065"),
      relayFee: parseEther("0.0006"),
    },
    {
      kind: "session" as const,
      gasUsed: 456_058n,
      effectiveGasPrice: 473_300_000n,
      registrationFee: parseEther("0.000241683"),
      fronted: parseEther("0.001054237"),
      relayFee: parseEther("0.000477448"),
    },
  ];

  test("the fork rehearsal's CELO charge is Chainlink plus 2%", () => {
    const report = chargeReport({
      token: celo,
      native: eth,
      writes: forkWrites,
      locked: parseEther("81.548572"),
      marginBps: 200,
      toleranceBps: 25,
    });

    expect(report.fronted).toBe(parseEther("0.002592302"));
    expect(report.conversionMarginBps).toBeGreaterThan(199.9);
    expect(report.conversionMarginBps).toBeLessThan(200.1);
    expect(report.verdict).toBe("PASS");
    // $5.47 locked for a write whose fees and gas came to $2.04.
    expect(report.overActualCostBps).toBeGreaterThan(16_000);
    expect(report.overActualCostBps).toBeLessThan(17_500);
  });

  test("the USDC charge of the same rehearsal passes too", () => {
    const report = chargeReport({
      token: { symbol: "USDC", decimals: 6, price: usd("1") },
      native: eth,
      writes: [
        { ...forkWrites[0]!, fronted: parseEther("0.001506845") },
        { ...forkWrites[1]!, fronted: parseEther("0.001054237") },
      ],
      locked: parseUnits("5.404400", 6),
      marginBps: 200,
      toleranceBps: 25,
    });

    expect(report.conversionMarginBps).toBeGreaterThan(199.9);
    expect(report.conversionMarginBps).toBeLessThan(200.1);
    expect(report.verdict).toBe("PASS");
  });

  test("a charge well above the margin fails, with the numbers", () => {
    const report = chargeReport({
      token: celo,
      native: eth,
      writes: forkWrites,
      locked: parseEther("90"),
      marginBps: 200,
      toleranceBps: 25,
    });

    expect(report.verdict).toBe("FAIL");
    expect(report.conversionMarginBps).toBeGreaterThan(1_200);
    expect(report.lines.join("\n")).toContain("FAIL");
  });

  test("a charge with no margin at all fails as well: the check is two-sided", () => {
    const fronted = parseEther("0.002592302");
    const report = chargeReport({
      token: celo,
      native: eth,
      writes: forkWrites,
      locked: convert(fronted, eth, celo),
      marginBps: 200,
      toleranceBps: 25,
    });

    expect(report.conversionMarginBps).toBeLessThan(1);
    expect(report.verdict).toBe("FAIL");
  });

  test("the lines say what was locked, what was fronted and what the write cost", () => {
    const { lines } = chargeReport({
      token: celo,
      native: eth,
      writes: forkWrites,
      locked: parseEther("81.548572"),
      marginBps: 200,
      toleranceBps: 25,
    });
    const text = lines.join("\n");

    expect(text).toContain("locked on the funding chain for the registry write: 81.548572 CELO");
    expect(text).toContain("fronted on the registry chain: 0.002592302 ETH");
    expect(text).toContain("registration fees 0.000483366 ETH");
    expect(text).toContain("configured margin 2.00%");
  });

  test("nothing to compare against is an error, not a pass", () => {
    expect(() =>
      chargeReport({ token: celo, native: eth, writes: [], locked: 1n, marginBps: 200, toleranceBps: 25 }),
    ).toThrow(/no registry write/);
  });
});
