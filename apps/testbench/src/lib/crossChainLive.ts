import { networkByChainId, type NetworkConfig } from "@altananetwork/sdk";
import * as Key from "porto/viem/Key";
import * as RelayActions from "porto/viem/RelayActions";
import { createClient, createPublicClient, decodeAbiParameters, encodeFunctionData, http, parseAbiParameters, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { CONTROLLER, DESTINATION_CHAIN_ID, ESCROW, KEYSTORE, registrationAbi, type CrossChainDeps, type Prepared } from "./crossChain";
import { sameAddress } from "./format";

const callsAbi = parseAbiParameters("(address to,uint256 value,bytes data)[]");

type Quote = { chainId: number | string; intent?: { executionData?: Hex; paymentMaxAmount?: bigint | string } };
type Context = { quote?: { multiChainRoot?: Hex; quotes?: Quote[] } };

function summarize(raw: { context: unknown }, sourceChainId: number): Prepared {
  const ctx = raw.context as Context;
  const quotes = ctx.quote?.quotes ?? [];
  const quoteChainIds = quotes.map((q) => Number(q.chainId));
  const source = quotes.find((q) => Number(q.chainId) === sourceChainId);
  let escrowed = 0n;
  if (source?.intent?.executionData) {
    try {
      const [calls] = decodeAbiParameters(callsAbi, source.intent.executionData);
      for (const c of calls) if (sameAddress(c.to, ESCROW)) escrowed += c.value;
    } catch {
      /* leave at zero; the log has the raw quote */
    }
  }
  const sourceFeeMax = source?.intent?.paymentMaxAmount ? BigInt(source.intent.paymentMaxAmount) : 0n;
  return { multiChainRoot: ctx.quote?.multiChainRoot, quoteChainIds, escrowed, sourceFeeMax, raw };
}

/** Real dependencies: public RPCs for reads, the relay through porto for the bundle. */
export function liveDeps(args: { walletKey: Hex; source: NetworkConfig }): CrossChainDeps {
  const destination = networkByChainId(DESTINATION_CHAIN_ID)!;
  const relayUrl = args.source.relayUrl ?? destination.relayUrl;
  if (!relayUrl) throw new Error("No relay configured for the source chain.");
  const account = privateKeyToAccount(args.walletKey);
  const dst = createPublicClient({ chain: sepolia, transport: http(destination.publicRpcUrl) });
  const src = createPublicClient({ chain: args.source.chain, transport: http(args.source.publicRpcUrl) });
  const relay = createClient({ chain: sepolia, transport: http(relayUrl) });
  const key = Key.fromSecp256k1({ privateKey: args.walletKey, role: "admin" });

  return {
    readFee: () => dst.readContract({ address: CONTROLLER, abi: registrationAbi, functionName: "getRegistrationFeeInWei" }),
    isValidKey: (wallet: Address, keyId: Hex) => dst.readContract({ address: KEYSTORE, abi: registrationAbi, functionName: "isValidKey", args: [wallet, keyId] }),
    sourceBalance: () => src.getBalance({ address: account.address }),
    prepare: async ({ fee, keyId, publicKey }) => {
      const prepared = await RelayActions.prepareCalls(relay, {
        account,
        feeToken: zeroAddress,
        requiredFunds: [{ address: zeroAddress, value: fee }],
        calls: [
          {
            to: CONTROLLER,
            value: fee,
            data: encodeFunctionData({ abi: registrationAbi, functionName: "initialRegisterKey", args: [keyId, zeroAddress, "0x", publicKey, 0] }),
          },
        ],
      });
      return summarize(prepared, args.source.chainId);
    },
    sign: (prepared) => RelayActions.signCalls(prepared.raw as Parameters<typeof RelayActions.signCalls>[0], { key }),
    send: async (prepared, signature) => {
      const p = prepared.raw as { context: unknown; capabilities?: unknown };
      const sent = await RelayActions.sendPreparedCalls(relay, {
        context: p.context as Parameters<typeof RelayActions.sendPreparedCalls>[1]["context"],
        capabilities: p.capabilities as Parameters<typeof RelayActions.sendPreparedCalls>[1]["capabilities"],
        signature,
      });
      return typeof sent === "string" ? sent : (sent as { id: string }).id;
    },
    status: async (id) => {
      const s = await RelayActions.getCallsStatus(relay, { id: id as Hex });
      const receipts = ((s as { receipts?: { chainId: number | string; transactionHash: Hex }[] }).receipts ?? []).map((r) => ({
        chainId: Number(r.chainId),
        transactionHash: r.transactionHash,
      }));
      return { status: Number(s.status), receipts };
    },
  };
}
