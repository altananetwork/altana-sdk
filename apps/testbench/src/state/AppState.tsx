import { signerFromPrivateKey, type FeeCurrency, type HoldingsResult, type Signer } from "@altananetwork/sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { DEFAULT_CHAIN_ID } from "../lib/chains";
import type { LogEntry } from "../lib/log";
import type { TestbenchClient } from "../lib/sdk";
import { load, save, type StoredSession, type StoredState, type Storage } from "../lib/storage";

export type WalletState = { key: Hex; address: Address; signer: Signer; registered: boolean };

export type AppState = {
  wallet?: WalletState;
  chainId: number;
  holdings?: HoldingsResult;
  holdingsChainId?: number;
  feeCurrencies?: FeeCurrency[];
  feeCurrenciesChainId?: number;
  sessions: StoredSession[];
  log: LogEntry[];
};

export type Action =
  | { type: "wallet/set"; key: Hex }
  | { type: "wallet/registered" }
  | { type: "wallet/clear" }
  | { type: "chain/set"; chainId: number }
  | { type: "holdings/set"; chainId: number; holdings: HoldingsResult }
  | { type: "fees/set"; chainId: number; currencies: FeeCurrency[] }
  | { type: "sessions/add"; session: StoredSession }
  | { type: "sessions/update"; id: string; patch: Partial<StoredSession> }
  | { type: "sessions/remove"; id: string }
  | { type: "log/add"; entry: LogEntry }
  | { type: "log/clear" };

export function walletFromKey(key: Hex): WalletState {
  const account = privateKeyToAccount(key);
  return { key, address: account.address, signer: signerFromPrivateKey(key), registered: false };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "wallet/set":
      return { ...state, wallet: walletFromKey(action.key), holdings: undefined, holdingsChainId: undefined };
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
    wallet: stored.walletKey ? walletFromKey(stored.walletKey) : undefined,
    chainId: stored.chainId ?? DEFAULT_CHAIN_ID,
    sessions: stored.sessions,
    log: [],
  };
}

export function toStored(state: AppState): StoredState {
  return {
    v: 1,
    ...(state.wallet ? { walletKey: state.wallet.key } : {}),
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
  }, [state.wallet?.key, state.chainId, state.sessions, storage]);
  const value = useMemo(() => ({ state, dispatch, client }), [state, client]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): Ctx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp outside AppProvider");
  return ctx;
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
