import { describe, expect, test } from "vitest";
import { addressUrl, txUrl } from "../../src/lib/explorer";

describe("explorer links", () => {
  test("known chains", () => {
    expect(txUrl(11142220, "0xab")).toBe("https://sepolia.celoscan.io/tx/0xab");
    expect(txUrl(11155111, "0xab")).toBe("https://sepolia.etherscan.io/tx/0xab");
    expect(addressUrl(84532, "0xcd")).toBe("https://sepolia.basescan.org/address/0xcd");
  });
  test("unknown chain yields no link", () => {
    expect(txUrl(424242, "0xab")).toBeUndefined();
  });
});
