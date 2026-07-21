/**
 * LIVE B402 buy with a PLAIN root-key signature (EIP-7702 pattern):
 * the wallet address == the admin EOA address, so an ordinary ECDSA
 * signature satisfies both a naive ecrecover-validating facilitator AND
 * (if it settles via ecrecover-or-1271) the chain.
 */
import { formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildPermit2WitnessTypedData, encodeXPaymentHeader } from "@altananetwork/sdk";
import { buildPublicClient } from "../../packages/wallet/src/internal/relay.js";
import { BNB } from "@altananetwork/sdk";

const STATE_FILE = new URL("./.live-hire-state.json", import.meta.url).pathname;
const URL_TO_BUY = process.argv[2] ?? "https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC";
const U = "0xcE24439F2D9C6a2289F741120FE202248B666666" as const;
const ERC20_ABI = [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const;

const state = JSON.parse(await Bun.file(STATE_FILE).text());
const account = privateKeyToAccount(process.env.USE_PROBE_EOA ? state.probeEoaKey : state.adminPrivateKey);
const publicClient = buildPublicClient(BNB);

const first = await fetch(URL_TO_BUY);
if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
const challenge: any = await first.json();
const rail = process.argv[3] ?? "eip3009";
const req = challenge.accepts.find(
  (a: any) => a.network === "eip155:56" && a.extra?.assetTransferMethod === rail,
);
if (!req) throw new Error(`no ${rail} BSC option`);
console.log(`challenge: ${formatUnits(BigInt(req.amount), 18)} $U → ${req.payTo} (spender ${req.extra.spenderAddress})`);

const now = Math.floor(Date.now() / 1000);
let header: string;

if (rail === "eip3009") {
  // Byte-for-byte the bnbagent-studio buyer envelope (proven against CMC in
  // the wild): {x402Version, resource, accepted, payload:{signature, authorization}}
  const auth = {
    from: account.address,
    to: req.payTo,
    value: String(req.amount),
    validAfter: String(now - 120), // studio backdates for clock skew
    validBefore: String(now + (req.maxTimeoutSeconds ?? 30)),
    nonce: ("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")) as `0x${string}`,
  };
  const signature = await account.signTypedData({
    domain: { name: req.extra.name, version: req.extra.version, chainId: 56, verifyingContract: req.asset },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { from: auth.from, to: auth.to, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce },
  });
  header = Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: challenge.resource,
    accepted: req,
    payload: { signature, authorization: auth },
  })).toString("base64");
} else {
  const nonce = BigInt("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"));
  const deadline = BigInt(now + (req.maxTimeoutSeconds ?? 30));
  const typed = buildPermit2WitnessTypedData({
    chainId: 56,
    token: req.asset,
    amount: BigInt(req.amount),
    spender: req.extra.spenderAddress,
    nonce,
    deadline,
    to: req.payTo,
    validAfter: 0n,
  });
  const signature = await account.signTypedData(typed as never); // plain 65-byte ECDSA
  const { x402Version: _v, ...accepted } = { ...req, x402Version: challenge.x402Version };
  header = encodeXPaymentHeader({
    x402Version: challenge.x402Version ?? 2,
    scheme: req.scheme,
    network: req.network,
    accepted: accepted as never,
    payload: {
      signature,
      from: account.address,
      permit: {
        permitted: { token: req.asset, amount: String(req.amount) },
        spender: req.extra.spenderAddress,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
        witness: { to: req.payTo, validAfter: "0" },
      },
    },
  });
}

const balBefore = await publicClient.readContract({ address: U, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
const res = await fetch(URL_TO_BUY, { headers: { "X-PAYMENT": header } });
const body = await res.text();
const balAfter = await publicClient.readContract({ address: U, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] });
console.log(`HTTP ${res.status} — paid ${formatUnits(balBefore - balAfter, 18)} $U`);
console.log(`body: ${body.slice(0, 900)}`);
