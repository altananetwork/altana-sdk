/**
 * When a refusal is about prices, and when it is not.
 *
 * The relay answers a price that is too old with the same bare revert as
 * every other refusal to fund, so the SDK reads the feeds the conversion
 * depends on. These tests fix what counts: only a feed that really is older
 * than the relay accepts, only on a request that converts between assets, and
 * never a feed that could not be read. The reader is injected; no chain and no
 * network is used.
 */
import { describe, expect, test } from "bun:test";
import { BASE_SEPOLIA, CELO, CELO_SEPOLIA, ETHEREUM, SEPOLIA, type PriceFeed } from "../config.js";
import { findStalePrice, type FeedReader } from "./priceFeeds.js";

const NOW = 1_800_000_000n;

/** A reader that answers each feed with the age given for its address. */
function feedsAged(ages: Record<string, number | Error>): FeedReader & { read: PriceFeed[] } {
  const read: PriceFeed[] = [];
  const reader = (async (feed: PriceFeed) => {
    read.push(feed);
    const age = ages[feed.address];
    if (age === undefined) throw new Error(`no answer for ${feed.address}`);
    if (age instanceof Error) throw age;
    return { updatedAt: NOW - BigInt(age), now: NOW };
  }) as FeedReader & { read: PriceFeed[] };
  reader.read = read;
  return reader;
}

const ETH_FEED = ETHEREUM.nativePriceFeed!;
const CELO_FEED = CELO.nativePriceFeed!;

describe("the feeds the SDK reads", () => {
  test("mainnet: ETH/USD on Ethereum and CELO/USD on Celo, at the relay's limit", () => {
    expect(ETH_FEED.address).toBe("0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419");
    expect(ETH_FEED.chain.id).toBe(1);
    expect(CELO_FEED.address).toBe("0x0568fD19986748cEfF3301e55c0eb1E729E0Ab7e");
    expect(CELO_FEED.chain.id).toBe(42220);
    expect(ETH_FEED.maxAgeSecs).toBe(3900);
    expect(CELO_FEED.maxAgeSecs).toBe(3900);
  });

  test("testnet: CELO is priced from the feed on Celo, as the testnet relay prices it", () => {
    expect(SEPOLIA.nativePriceFeed!.address).toBe("0x694AA1769357215DE4FAC081bf1f309aDC325306");
    expect(CELO_SEPOLIA.nativePriceFeed!.address).toBe(CELO_FEED.address);
    expect(CELO_SEPOLIA.nativePriceFeed!.chain.id).toBe(42220);
    expect(SEPOLIA.nativePriceFeed!.maxAgeSecs).toBe(7200);
  });
});

describe("a Celo-paid request on Ethereum", () => {
  const request = { destination: ETHEREUM, source: CELO, sourceNativeHeld: true };

  test("both prices fresh: nothing is stale", async () => {
    const read = feedsAged({ [ETH_FEED.address]: 3624, [CELO_FEED.address]: 270 });
    expect(await findStalePrice({ ...request, read })).toBeUndefined();
    expect(read.read).toHaveLength(2);
  });

  test("a price exactly at the limit is still usable, as it is for the relay", async () => {
    const read = feedsAged({ [ETH_FEED.address]: 3900, [CELO_FEED.address]: 3900 });
    expect(await findStalePrice({ ...request, read })).toBeUndefined();
  });

  test("the destination's price one second past the limit is stale", async () => {
    const read = feedsAged({ [ETH_FEED.address]: 3901, [CELO_FEED.address]: 270 });
    expect(await findStalePrice({ ...request, read })).toEqual({
      asset: "ETH",
      ageSecs: 3901,
      maxAgeSecs: 3900,
      feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419 on Ethereum",
    });
  });

  test("the price of what the wallet pays with is stale", async () => {
    const read = feedsAged({ [ETH_FEED.address]: 100, [CELO_FEED.address]: 4000 });
    expect(await findStalePrice({ ...request, read })).toMatchObject({ asset: "CELO", ageSecs: 4000, maxAgeSecs: 3900 });
  });

  test("a wallet holding no CELO does not depend on its price", async () => {
    const read = feedsAged({ [ETH_FEED.address]: 100, [CELO_FEED.address]: 4000 });
    expect(await findStalePrice({ ...request, sourceNativeHeld: false, read })).toBeUndefined();
    expect(read.read.map((feed) => feed.address)).toEqual([ETH_FEED.address]);
  });

  test("a feed that cannot be read is not evidence of anything", async () => {
    const read = feedsAged({ [ETH_FEED.address]: new Error("rpc down"), [CELO_FEED.address]: 270 });
    expect(await findStalePrice({ ...request, read })).toBeUndefined();
  });

  test("an unreadable feed does not hide a stale one", async () => {
    const read = feedsAged({ [ETH_FEED.address]: new Error("rpc down"), [CELO_FEED.address]: 4000 });
    expect(await findStalePrice({ ...request, read })).toMatchObject({ asset: "CELO" });
  });

  test("a feed that has never answered, or a clock behind the feed, is not an age", async () => {
    const never: FeedReader = async () => ({ updatedAt: 0n, now: NOW });
    const behind: FeedReader = async () => ({ updatedAt: NOW + 30n, now: NOW });
    expect(await findStalePrice({ ...request, read: never })).toBeUndefined();
    expect(await findStalePrice({ ...request, read: behind })).toBeUndefined();
  });
});

describe("a request that converts nothing", () => {
  test("ETH on Base Sepolia paying for ETH on Sepolia reads no feed", async () => {
    const read = feedsAged({ [SEPOLIA.nativePriceFeed!.address]: 999_999 });
    expect(await findStalePrice({ destination: SEPOLIA, source: BASE_SEPOLIA, sourceNativeHeld: true, read })).toBeUndefined();
    expect(read.read).toHaveLength(0);
  });
});
