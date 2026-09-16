# Altana test bench

A local page for checking the testnet relay by hand: fee tokens on Celo Sepolia, sessions, and cross-chain registration. It talks to the live testnet relay with a throwaway key kept in this browser. Never load a key that holds real funds.

## Run

```sh
bun install
bun run --filter '@altananetwork/testbench' dev
```

The dev script builds the SDK first, so the page always runs the SDK from this checkout. Open http://localhost:5174.

Optional environment (`.env.local`): `VITE_RELAY_URL` to point at another relay, `VITE_RPC_11142220`, `VITE_RPC_84532`, `VITE_RPC_11155111` for other RPCs.

## Test

```sh
bun run --filter '@altananetwork/testbench' typecheck
bun run --filter '@altananetwork/testbench' test
```

## Manual checklist

Filled in as the panels land.
