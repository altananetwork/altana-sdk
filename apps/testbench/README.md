# Altana test bench

A local page for checking Altana on Celo Sepolia by hand, and for walking the Celo milestones in front of someone. It talks to a relay with a throwaway key kept in this browser. Never load a key that holds real funds.

Nine tabs. **Walkthrough** is the showcase: the one flow the Celo milestones have to prove, one card per step. **Proof** is the milestone checklist with its evidence links. The rest are the tools each step is built from.

## Run

```sh
bun install
bun run --filter '@altananetwork/testbench' dev
```

The dev script builds the SDK first, so the page always runs the SDK from this checkout. Open http://localhost:5174.

Which relay it talks to is a setting on the **Settings** tab, not a build-time variable, because a demo is walked against more than one in a sitting. **The Settings tab asks the relay which chains it serves** and uses the answer; the table below is only where each preset starts, since a hardcoded list goes stale:

| Preset | URL | Chains it serves |
|---|---|---|
| Testnet relay | the live Railway relay | Celo Sepolia, Base Sepolia, Ethereum Sepolia |
| Local relay staging | `http://127.0.0.1:19129` | Celo Sepolia only |
| Local forks | `http://127.0.0.1:19139` | Celo Sepolia, Ethereum Sepolia |

The chain set travels with the relay choice on purpose. Configuring a chain the relay does not serve fails on the first call with an error that names neither the chain nor the relay, and a chain the relay *does* serve but the bench leaves off silently skips whatever needed it. `VITE_RELAY_URL` still works and selects the matching preset at first load; `VITE_RPC_11142220`, `VITE_RPC_84532` and `VITE_RPC_11155111` override the RPCs.

## Test

```sh
bun run --filter '@altananetwork/testbench' typecheck
bun run --filter '@altananetwork/testbench' test
```

Component tests run against a fake SDK client. `tests/brand.test.ts` enforces the Brand Kit hard rules on the source, and `tests/components/brandPanels.test.tsx` enforces them on what is actually rendered. Both run in CI.

### If vitest cannot find a rollup binding

```
Error: Cannot find module '@rollup/rollup-darwin-x64'
```

The `node` on the default PATH is x64 while the machine is arm64, so rollup asks for a binding bun never installed. Run it with the arm64 node:

```sh
PATH="/opt/homebrew/bin:$PATH" bunx vitest run
```

Nothing in `package.json` fixes this: under bun's isolated layout the root pin is never visible to rollup's own directory, whichever binding it names. It does not affect CI.

## The demo, in the order to click through it

Roughly 20 minutes, plus the Celo anchor's own wait. Before you start: Settings, pick the relay; Wallet, generate a key and fund it with 0.5 CELO from the faucet.

1. **Walkthrough**, steps 1 to 3. A wallet on Celo, its balances with zero ETH on Ethereum, and a transaction whose fee is charged in the token you picked. This is milestone 2a in one screen.
2. **Walkthrough**, step 4. Registering the session key in the Ethereum Sepolia KeyStore out of the Celo balance. On every live relay today this fails, for a relay bug awaiting a decision, and the card shows the relay's own words. Say so; it is the honest state of the milestone, and it is the one thing the whole spine turns on.
3. **Walkthrough**, step 5, the mirror card, or the **Celo mirror** tab for a key registered earlier. See below: it has a clock in it.
4. **Walkthrough**, step 6. The session key signs a transaction of its own, then the wallet revokes it. The mirror carries the revocation one anchor later, so do not wait for it on stage: point at the card and say when it will flip.
5. **Passkey**. Create a passkey wallet and show the same address on every chain, then execute, grant and revoke with it.
6. **x402**. Ask the seller what it charges, then pay, and read which rail carried it. The point to make: an Altana smart account pays over Permit2 and settles locally, because Celo's USDC checks an EIP-3009 signature with ecrecover and cannot verify a contract wallet's.
7. **Agent identity**. Agent 449 is Altana's, registered live on Celo Sepolia. Read it, then mint one from the wallet in use.
8. **Proof**. The whole checklist with its evidence links, as qa's matrix has it.

### The mirror card has a clock in it, so plan around it

The Celo cache only counts a key as valid while the block it was proven against is **exactly** the block Celo currently anchors. That anchor jumps about every 20 minutes and trails Ethereum by 15 to 20 minutes. Two consequences for a demo:

- A key registered during the demo is not provable for about half an hour. The card shows that as a wait with a rough countdown, which is the truth, not an error.
- **Prove and read in one go.** A proof is only good until the next anchor update, about 20 minutes, after which the same key reads as not valid with nothing having changed on Ethereum. Do not prove a key, talk for half an hour, and then show the card.

So register the keys you want to show **ahead of time**, and keep each key's **public key**, not just its address or key hash: the card can read any key from its hash, but `populateKey` takes the public key bytes, so a key entered as a bare hash can be read and not proven. The **Celo mirror** tab takes either, and a session granted in this browser is picked from a list with its public key already attached.

## The x402 seller

The x402 panel buys from a local merchant. Start it from `tests/e2e` with the shared testnet env sourced:

```sh
set -a; source /path/to/.env.testnet; set +a
cd tests/e2e && bun run serve:x402-celo
```

That script builds `@altananetwork/x402-server` before starting, so it works from a clean checkout; without the build it fails with "Cannot find module '@altananetwork/x402-server'".

It sells one paid route at 0.01 USDC on live Celo Sepolia, over Permit2 and EIP-3009, and reports its own receipt so the panel names the rail rather than inferring it. With `X402_CELO_API_KEY` set it settles the EIP-3009 rail through Celo's facilitator; Permit2 always settles from the merchant's key, because the facilitator does not take that rail.

## The proof view

`public/proof.json` is generated from qa's verification matrix:

```sh
node scripts/build-proof.mjs                       # finds celo-harness/MATRIX.md
node scripts/build-proof.mjs path/to/MATRIX.md path/to/proof.json
```

Re-run it after every matrix update. The matrix stays the single source of truth; this view never states a status of its own.

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
4. Send with Force one token = EURm while holding none. Pass: the send fails and the Result panel shows the relay's reason, with no stale result from the previous send beside it. It fails **at** the relay, not before it: there is no pre-flight check on a forced fee token for a wallet-key send, and the message names neither the accepted tokens nor what the wallet holds. That is the product today (qa, 2026-09-28); the weak message is an SDK matter, not a bench one.

### 4. Grant, use and revoke a session paying fees in USDC

1. Sessions: name "agent one", cap 2.5 USDC per day, lifetime 7 days, chain Celo Sepolia, tick USDC under fee tokens. Quote first.
2. Pass on quote: one line per leg, balances table shows Enough on the wallet's chain.
3. Grant session. No Sepolia ETH is needed: the registry write on Sepolia shows "funded from Celo Sepolia" with the source transaction. Pass: registry and account legs CONFIRMED (the cache leg may take a while); the session appears under Stored sessions as Active with "2.5 USDC per day".
4. Execute on that session. Pass: CONFIRMED, "Charged in USDC", the wallet's USDC dropped by the fee; CELO unchanged.
5. Revoke. Pass: legs CONFIRMED, badge turns Revoked, Execute is disabled.

### 5. A wallet with only CELO registers a key on Ethereum Sepolia (demo pricing)

1. Wallet: Generate a new key, send it 0.5 CELO, Register with relay. Do not fund it on Sepolia.
2. Cross-chain: source Celo Sepolia, Register through the relay.
3. Pass: all seven steps done; result shows the fee, the amount locked on Celo, two quotes under one root, transactions on both chains, and "Key valid in the Sepolia KeyStore". The banner above explains that the locked amount is not market priced.
4. Repeat with a Base Sepolia funded key and source Base Sepolia.

### What each panel calls

Walkthrough: `holdings`, `execute` with `feeToken`, `grantSession`, then the mirror card's reads. Wallet: `createWallet`, `holdings`, `quoteExecute` for move-all. Passkey: `createPasskeyWallet`, `recoverFromPasskey`, `execute`, `grantSession`, `revokeSession`. Fee tokens: `feeCurrencies`. Send: `execute` with `feeToken` absent, one address, or a list. Sessions: `quoteGrantSession`, `grantSession`, `execute` with a session, `quoteRevokeSession`, `revokeSession`. Mirror card: `readL1Anchor` and `readCachedKey` on Celo, two `eth_getStorageAt` reads of the Ethereum KeyStore slot (at the head and at the anchored block), and `syncSessionToCache` to prove. x402: `selectX402Requirement`, then `fetchWithX402`. Agent identity: `getErc8004Agent`, `registerErc8004Agent`. Cross-chain: porto `prepareCalls` with `requiredFunds`, `signCalls`, `sendPreparedCalls`, `getCallsStatus`, then `isValidKey` on the Sepolia KeyStore. Proof: a static `public/proof.json`, no chain calls.

### Why the mirror card reads a storage slot rather than calling isValidKey

`isValidKey` reverts when the cache entry is stale, so it answers false for four different situations that need four different actions. The card reads the KeyStore's packed Key slot twice, at Ethereum's head and at the block Celo anchors, and compares them. That is exactly the value `populateKey` proves, so "the anchor has not reached the registration" and "the anchor has not reached the revocation" and "a proof would work right now" are told apart instead of collapsing into one unhelpful false.
