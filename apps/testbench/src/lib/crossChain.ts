import { SEPOLIA } from "@altananetwork/sdk";
import { keccak256, parseAbi, type Address, type Hex } from "viem";

/* Cross-chain registration: a wallet funded on a source chain registers its own
   key in the Sepolia KeyStore, the relay fronting the ETH. Same flow as
   altana-relay-mainnet/scripts/testnet-interop-register.cjs, driven through
   porto directly because the SDK has no cross-chain funding call yet. */

export const CONTROLLER: Address = SEPOLIA.keyStoreController;
export const KEYSTORE: Address = SEPOLIA.keyStore;
export const DESTINATION_CHAIN_ID = SEPOLIA.chainId;
/** Testnet Escrow (account stack, same address on every testnet). */
export const ESCROW: Address = "0xCd075ceb5Cd463a9233a8085fc915767139F655c";

export const registrationAbi = parseAbi([
  "function initialRegisterKey(bytes32 keyId, address signatureChecker, bytes checkerData, bytes publicKey, uint40 expiry) payable",
  "function getRegistrationFeeInWei() view returns (uint256)",
  "function isValidKey(address user, bytes32 keyId) view returns (bool)",
]);

export type Step = "fee" | "balance" | "prepare" | "sign" | "send" | "wait" | "verify";
export const STEPS: { id: Step; label: string }[] = [
  { id: "fee", label: "Read the registration fee on Sepolia" },
  { id: "balance", label: "Check the source balance and that the key is not registered yet" },
  { id: "prepare", label: "Ask the relay for a two-chain quote (source escrow + Sepolia registration)" },
  { id: "sign", label: "Sign once over the multichain root" },
  { id: "send", label: "Send the bundle" },
  { id: "wait", label: "Wait for both chains to execute" },
  { id: "verify", label: "Verify the key in the Sepolia KeyStore" },
];

export type Receipt = { chainId: number; transactionHash: Hex };
export type Prepared = {
  multiChainRoot?: Hex;
  quoteChainIds: number[];
  escrowed: bigint;
  sourceFeeMax: bigint;
  raw: unknown;
};

export type CrossChainDeps = {
  readFee(): Promise<bigint>;
  isValidKey(wallet: Address, keyId: Hex): Promise<boolean>;
  sourceBalance(): Promise<bigint>;
  prepare(args: { fee: bigint; keyId: Hex; publicKey: Hex }): Promise<Prepared>;
  sign(prepared: Prepared): Promise<Hex>;
  send(prepared: Prepared, signature: Hex): Promise<string>;
  status(bundleId: string): Promise<{ status: number; receipts: Receipt[] }>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
};

export type StepState = { step: Step; state: "pending" | "running" | "done" | "failed"; detail?: string };

export type CrossChainResult = {
  fee: bigint;
  keyId: Hex;
  multiChainRoot?: Hex;
  quoteChainIds: number[];
  escrowed: bigint;
  sourceFeeMax: bigint;
  bundleId: string;
  receipts: Receipt[];
  valid: boolean;
};

export function keyIdOf(publicKey: Hex): Hex {
  return keccak256(publicKey);
}

/** Runs the flow, reporting each step. Throws with the failing step's reason. */
export async function runCrossChain(
  deps: CrossChainDeps,
  args: { wallet: Address; publicKey: Hex; onStep: (s: StepState) => void; timeoutMs?: number },
): Promise<CrossChainResult> {
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const keyId = keyIdOf(args.publicKey);
  const at = async <T>(step: Step, fn: () => Promise<T>, detail?: (t: T) => string): Promise<T> => {
    args.onStep({ step, state: "running" });
    try {
      const out = await fn();
      args.onStep({ step, state: "done", ...(detail ? { detail: detail(out) } : {}) });
      return out;
    } catch (e) {
      args.onStep({ step, state: "failed", detail: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  };

  const fee = await at("fee", () => deps.readFee(), (f) => `${f} wei`);
  await at("balance", async () => {
    if (await deps.isValidKey(args.wallet, keyId)) throw new Error("This key is already registered in the Sepolia KeyStore. Use a fresh wallet.");
    const balance = await deps.sourceBalance();
    if (balance === 0n) throw new Error("The wallet holds nothing on the source chain.");
    return balance;
  }, (b) => `${b} wei on the source chain`);
  const prepared = await at("prepare", () => deps.prepare({ fee, keyId, publicKey: args.publicKey }), (p) =>
    p.quoteChainIds.length === 2 ? `two quotes under one root, escrow ${p.escrowed} wei` : `${p.quoteChainIds.length} quote(s)`,
  );
  if (prepared.quoteChainIds.length !== 2) throw new Error("Expected a source quote and a Sepolia quote under one root.");
  const signature = await at("sign", () => deps.sign(prepared));
  const bundleId = await at("send", () => deps.send(prepared, signature), (id) => id);
  const receipts = await at(
    "wait",
    async () => {
      const deadline = now() + (args.timeoutMs ?? 300_000);
      while (now() < deadline) {
        const s = await deps.status(bundleId);
        if (s.status >= 200) {
          if (s.status !== 200) throw new Error(`Bundle finished with status ${s.status}`);
          return s.receipts;
        }
        await sleep(2000);
      }
      throw new Error("Timed out waiting for the bundle.");
    },
    (r) => `${r.length} receipt(s)`,
  );
  const valid = await at("verify", () => deps.isValidKey(args.wallet, keyId), (v) => (v ? "key is valid" : "key not found"));
  return { fee, keyId, multiChainRoot: prepared.multiChainRoot, quoteChainIds: prepared.quoteChainIds, escrowed: prepared.escrowed, sourceFeeMax: prepared.sourceFeeMax, bundleId, receipts, valid };
}
