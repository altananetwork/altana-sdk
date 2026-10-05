import {
  signerFromPasskey,
  signerFromPrivateKey,
  type FeeCurrency,
  type Signer,
} from "@altananetwork/sdk";
import type { MergedHoldings } from "../lib/holdings";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { DEFAULT_CHAIN_ID } from "../lib/chains";
import type { LogEntry } from "../lib/log";
import type { TestbenchClient } from "../lib/sdk";
import { load, save, type StoredPasskey, type StoredSession, type StoredState, type Storage } from "../lib/storage";

/**
 * The wallet the panels act with. A passkey wallet carries no private key:
 * the signer is the passkey and the address came from createWallet, because a
 * passkey is not an EOA and has no address of its own. `key` is therefore
 * present only for a generated or pasted private key, and the two features
 * that need the raw key (revealing it, and the porto cross-chain path) are
 * offered only then.
 */
export type WalletState = {
  kind: "privateKey" | "passkey";
  key?: Hex;
  passkey?: StoredPasskey;
  address: Address;
  signer: Signer;
  registered: boolean;
};

export type AppState = {
  wallet?: WalletState;
  chainId: number;
  holdings?: MergedHoldings;
  holdingsChainId?: number;
  feeCurrencies?: FeeCurrency[];
  feeCurrenciesChainId?: number;
  sessions: StoredSession[];
  log: LogEntry[];
};

export type Action =
  | { type: "wallet/set"; key: Hex }
  | { type: "wallet/setPasskey"; passkey: StoredPasskey; registered?: boolean }
  | { type: "wallet/registered" }
  | { type: "wallet/clear" }
  | { type: "chain/set"; chainId: number }
  | { type: "holdings/set"; chainId: number; holdings: MergedHoldings }
  | { type: "fees/set"; chainId: number; currencies: FeeCurrency[] }
  | { type: "sessions/add"; session: StoredSession }
  | { type: "sessions/update"; id: string; patch: Partial<StoredSession> }
  | { type: "sessions/remove"; id: string }
  | { type: "log/add"; entry: LogEntry }
  | { type: "log/clear" };

export function walletFromKey(key: Hex, registered = false): WalletState {
  const account = privateKeyToAccount(key);
  return { kind: "privateKey", key, address: account.address, signer: signerFromPrivateKey(key), registered };
}

export function walletFromPasskey(passkey: StoredPasskey, registered = false): WalletState {
  return {
    kind: "passkey",
    passkey,
    address: passkey.address,
    signer: signerFromPasskey(passkey.credential),
    registered,
  };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "wallet/set":
      return { ...state, wallet: walletFromKey(action.key), holdings: undefined, holdingsChainId: undefined };
    case "wallet/setPasskey":
      return {
        ...state,
        wallet: walletFromPasskey(action.passkey, action.registered ?? false),
        holdings: undefined,
        holdingsChainId: undefined,
      };
    case "wallet/registered":
      return state.wallet ? { ...state, wallet: { ...state.wallet, registered: true } } : state;
    case "wallet/clear":
      return { ...state, wallet: undefined, holdings: undefined, holdingsChainId: undefined, sessions: [] };
    case "chain/set":
      return { ...state, chainId: action.chainId };
    case "holdings/set":
      return { ...state, holdings: action.holdings, holdingsChainId: action.chainId };
    case "fees/set":
      return { ...state, feeCurrencies: action.currencies, feeCurrenciesChainId: action.chainId };
    case "sessions/add":
      return { ...state, sessions: [action.session, ...state.sessions] };
    case "sessions/update":
      return { ...state, sessions: state.sessions.map((s) => (s.id === action.id ? { ...s, ...action.patch } : s)) };
    case "sessions/remove":
      return { ...state, sessions: state.sessions.filter((s) => s.id !== action.id) };
    case "log/add":
      return { ...state, log: [action.entry, ...state.log].slice(0, 300) };
    case "log/clear":
      return { ...state, log: [] };
  }
}

export function initialState(stored: StoredState): AppState {
  return {
    wallet: stored.walletKey
      ? walletFromKey(stored.walletKey, stored.registered === true)
      : stored.passkey
        ? walletFromPasskey(stored.passkey, stored.registered === true)
        : undefined,
    chainId: stored.chainId ?? DEFAULT_CHAIN_ID,
    sessions: stored.sessions,
    log: [],
  };
}

export function toStored(state: AppState): StoredState {
  return {
    v: 1,
    ...(state.wallet?.key ? { walletKey: state.wallet.key, registered: state.wallet.registered } : {}),
    ...(state.wallet?.passkey ? { passkey: state.wallet.passkey, registered: state.wallet.registered } : {}),
    chainId: state.chainId,
    sessions: state.sessions,
  };
}

type Ctx = { state: AppState; dispatch: (a: Action) => void; client: TestbenchClient };
const AppContext = createContext<Ctx | null>(null);

export function AppProvider({
  client,
  storage,
  children,
}: {
  client: TestbenchClient;
  storage: Storage;
  children: ReactNode;
}) {
  const [state, dispatch] = useReducer(reducer, storage, (s) => initialState(load(s)));
  useEffect(() => {
    save(storage, toStored(state));
  }, [state.wallet?.key, state.wallet?.passkey, state.wallet?.registered, state.chainId, state.sessions, storage]);
  const value = useMemo(() => ({ state, dispatch, client }), [state, client]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
}

/**
 * Registers the wallet with the relay before its first relay action, so a
 * fresh key never hits "quotes for unknown accounts are not accepted".
 */
export function useEnsureRegistered() {
  const { state, dispatch, client } = useApp();
  return useCallback(async () => {
    const w = state.wallet;
    if (!w || w.registered) return;
    await client.createWallet(w.signer);
    dispatch({ type: "wallet/registered" });
  }, [state.wallet, client, dispatch]);
}

/** Runs an async action and records a failure in the log without throwing to React. */
export function useRun() {
  const { dispatch } = useApp();
  return useCallback(
    async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        const { relayReason } = await import("../lib/errors");
        const { entry } = await import("../lib/log");
        dispatch({ type: "log/add", entry: entry(label, { error: relayReason(err), level: "error" }) });
      }
    },
    [dispatch],
  );
}
