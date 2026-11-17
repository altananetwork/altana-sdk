import { createPublicClient, http } from "viem";
import type { NetworkConfig, PriceFeed } from "../config.js";
import type { StalePrice } from "../errors.js";

/**
 * Whether a price the relay converts with is too old, read at the feed.
 *
 * The relay refuses to convert between two assets at a price older than its
 * limit. It writes the reason to its own log (`price for celo is 390s old at
 * the chainlink feed, limit is 60s`) and answers the caller with a revert
 * that carries no reason, the same answer it gives when it could not source
 * the funds for any other cause. Nothing in the response tells the two apart.
 *
 * The feed does. Its newest answer carries the time it was written, and that
 * is what the relay measures against, so the SDK reads it and compares. A
 * request is only said to have failed on prices when a feed it depends on
 * really is older than the relay accepts; a feed that cannot be read says
 * nothing, and the failure keeps the wording it had.
 */

const AGGREGATOR_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

/** A feed's newest answer and the time on its chain, both in unix seconds. */
export type FeedReading = { updatedAt: bigint; now: bigint };

/** Reads one feed. Injected in tests, so no test needs a chain. */
export type FeedReader = (feed: PriceFeed) => Promise<FeedReading>;

const FEED_READ_TIMEOUT_MS = 3_000;

/**
 * Reads a feed's `updatedAt` and its chain's newest block time.
 *
 * The age is measured against the chain's clock and not the device's: a phone
 * whose clock runs an hour fast would otherwise find every price an hour old.
 * A block is never stamped later than it was produced, so this can only
 * understate an age, which errs toward saying nothing.
 */
export const readFeed: FeedReader = async (feed) => {
  const client = createPublicClient({
    chain: feed.chain,
    transport: http(feed.publicRpcUrl, { timeout: FEED_READ_TIMEOUT_MS, retryCount: 0 }),
  });
  const [round, block] = await Promise.all([
    client.readContract({ address: feed.address, abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
    client.getBlock({ blockTag: "latest" }),
  ]);
  return { updatedAt: round[3], now: block.timestamp };
};

/** One asset whose price a conversion depends on. */
type PricedAsset = { asset: string; feed: PriceFeed };

/** The native asset of a network, when the relay prices it from a feed. */
function pricedNative(network: NetworkConfig): PricedAsset | undefined {
  return network.nativePriceFeed
    ? { asset: network.chain.nativeCurrency.symbol, feed: network.nativePriceFeed }
    : undefined;
}

/**
 * The first price a conversion depends on that is older than the relay
 * accepts, or nothing.
 *
 * `destination` is the chain the request is carried out on and `source` the
 * chain it is paid from. Nothing is read unless they have different native
 * assets: paying for ETH with ETH held on another chain converts nothing, and
 * no price can refuse it.
 *
 * The destination's price is needed whatever the wallet pays with. The
 * source's native price is needed only by a wallet that holds the native
 * asset there, which is what `sourceNativeHeld` says: the relay does not
 * price an asset the wallet has none of.
 */
export async function findStalePrice(args: {
  destination: NetworkConfig;
  source: NetworkConfig;
  sourceNativeHeld: boolean;
  read?: FeedReader;
}): Promise<StalePrice | undefined> {
  const { destination, source } = args;
  if (destination.chain.nativeCurrency.symbol === source.chain.nativeCurrency.symbol) return undefined;
  const read = args.read ?? readFeed;
  const needed = [pricedNative(destination), args.sourceNativeHeld ? pricedNative(source) : undefined].filter(
    (priced): priced is PricedAsset => priced !== undefined,
  );
  const checked = await Promise.all(needed.map((priced) => staleness(priced, read)));
  return checked.find((stale) => stale !== undefined);
}

/** How stale one price is, or nothing when it is fresh or could not be read. */
async function staleness(priced: PricedAsset, read: FeedReader): Promise<StalePrice | undefined> {
  let reading: FeedReading;
  try {
    reading = await withinTimeout(read(priced.feed));
  } catch {
    return undefined;
  }
  // A feed that has never answered reports zero, which is not an age.
  if (reading.updatedAt <= 0n || reading.now <= reading.updatedAt) return undefined;
  const ageSecs = Number(reading.now - reading.updatedAt);
  if (ageSecs <= priced.feed.maxAgeSecs) return undefined;
  return {
    asset: priced.asset,
    ageSecs,
    maxAgeSecs: priced.feed.maxAgeSecs,
    feed: `${priced.feed.address} on ${priced.feed.chain.name}`,
  };
}

async function withinTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("price feed read timed out")), FEED_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
