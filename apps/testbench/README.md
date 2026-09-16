# Altana test bench

A local page for checking the testnet relay by hand: fee tokens on Celo Sepolia, sessions, and cross-chain registration. It talks to the live testnet relay with a throwaway key kept in this browser. Never load a key that holds real funds.

## Run

```sh
bun install
bun run --filter '@altananetwork/testbench' dev
```

The dev script builds the SDK first, so the page always runs the SDK from this checkout. Open http://localhost:5174.

Optional environment in `apps/testbench/.env.local`: `VITE_RELAY_URL` to point at another relay, and `VITE_RPC_11142220`, `VITE_RPC_84532`, `VITE_RPC_11155111` for other RPCs.

## Test

```sh
bun run --filter '@altananetwork/testbench' typecheck
bun run --filter '@altananetwork/testbench' test
```

Component tests run against a fake SDK client. `tests/brand.test.ts` enforces the Brand Kit hard rules on the source: no em dashes, no monospace face, no eyebrows, critical red never filled.

## Manual checklist

Each scenario names what to do on the page and what a pass looks like. The Activity panel on the right records every relay call, so a failure always has a reason next to it. Fund wallets from the links in the Wallet panel; funding is manual.

### 1. A wallet with only CELO transacts and pays the fee in CELO

1. Wallet: Generate a new key, send it 0.5 CELO from the Celo faucet, Refresh, Register with relay.
2. Fee tokens: the list shows CELO plus USDC, USD₮, USDm, EURm, KESm with a rate for each; only CELO is marked Held.
3. Send: any recipient, 0.001, asset CELO, fee Automatic, Send.
4. Pass: status CONFIRMED, "Charged in CELO", CELO balance dropped by the amount plus the fee, transaction link opens on Celoscan.

### 2. A wallet with only USDC pays its fee in USDC (needs the relay with Celo fee tokens deployed)

1. Wallet: Generate a new key. Do not send it CELO. Send it 2 USDC from the Circle faucet. Refresh, Register with relay.
2. Fee tokens: USDC is marked Held, CELO is not.
3. Send: any recipient, 1, asset USDC, fee Automatic, Send.
4. Pass: CONFIRMED, "Charged in USDC", CELO stays 0, USDC dropped by 1 plus the fee.

### 3. Forcing a token, and choosing from a list

1. Wallet holding CELO and USDC (repeat the funding from 1 and 2 on one key).
2. Send with fee Force one token = USDC. Pass: "Charged in USDC".
3. Send with fee Choose from a list, tick EURm then USDC. Pass: "Charged in USDC" (EURm is accepted but not held, so the second choice wins).
4. Send with Force one token = EURm while holding none. Pass: the send fails before the relay with a message naming the accepted tokens and what the wallet holds.

### 4. Grant, use and revoke a session paying fees in USDC

1. Sessions: name "agent one", cap 2.5 USDC per day, lifetime 7 days, chain Celo Sepolia, tick USDC under fee tokens. Quote first.
2. Pass on quote: one line per leg, balances table shows Enough on the wallet's chain.
3. Grant session. Pass: legs table shows the registry write on Sepolia and the account leg on Celo Sepolia as CONFIRMED (the cache leg may be SKIPPED or take a while); the session appears under Stored sessions as Active with "2.5 USDC per day".
4. Execute on that session. Pass: CONFIRMED, "Charged in USDC", the wallet's USDC dropped by the fee; CELO unchanged.
5. Revoke. Pass: legs CONFIRMED, badge turns Revoked, Execute is disabled.

### 5. A wallet with only CELO registers a key on Ethereum Sepolia (demo pricing)

1. Wallet: Generate a new key, send it 0.5 CELO, Register with relay. Do not fund it on Sepolia.
2. Cross-chain: source Celo Sepolia, Register through the relay.
3. Pass: all seven steps done; result shows the fee, the amount locked on Celo, two quotes under one root, transactions on both chains, and "Key valid in the Sepolia KeyStore". The banner above explains that the locked amount is not market priced.
4. Repeat with a Base Sepolia funded key and source Base Sepolia.

### What each panel calls

Wallet: `createWallet`, `holdings`. Fee tokens: `feeCurrencies`. Send: `execute` with `feeToken` absent, one address, or a list. Sessions: `quoteGrantSession`, `grantSession`, `execute` with a session, `quoteRevokeSession`, `revokeSession`. Cross-chain: porto `prepareCalls` with `requiredFunds`, `signCalls`, `sendPreparedCalls`, `getCallsStatus`, then `isValidKey` on the Sepolia KeyStore.
