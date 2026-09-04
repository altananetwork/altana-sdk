# Changelog

Notable changes to `@altananetwork/sdk`, `@altananetwork/mcp` and
`@altananetwork/x402-server`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions below are the `@altananetwork/sdk` version; the matching
`@altananetwork/mcp` version is noted where it differs.

These packages are pre-1.0. Minor versions may contain breaking changes.

> This changelog starts at 0.7.0. Entries for earlier versions were
> reconstructed from commit history after the fact, so they summarize what
> shipped rather than itemizing every change.

## [Unreleased]

## [0.10.0] - 2026-09-04

`@altananetwork/mcp` 0.10.0 and `@altananetwork/x402-server` 0.3.0 ship with this release.

### Added

- **`client.holdings()` discovers which tokens a wallet holds.** `balances`
  needs an explicit token list; `holdings` asks the Altana relay for the
  wallet's assets on the chain (`wallet_getAssets`) and then reads every
  ERC-20 it names live, so the entries are the same `TokenBalance` shape as
  `balances`, BEP-677 display scaling included. Zero balances are dropped
  unless `includeZero: true`; tokens whose reads fail stay in the list as
  `ok: false`. No configuration: the relay already attached to the chain is
  used, so there is no indexer key and no token list to maintain. The MCP
  `wallet_balance` tool gains `discover: true`, which returns the discovered
  list flagged `discovered: true`, and the `wallet-balance` slash command
  now shows every token the wallet holds. Token reads are also chunked
  (40 tokens per multicall, at most 3 in flight) so a wallet with hundreds
  of tokens does not burst-fire calls at a public RPC. (#78)

### Fixed

- **Relay rejections now lead with the relay's actual reason.** A rejected
  request (for example an unaccepted `feeToken`) used to surface only
  viem's generic `Invalid parameters were provided to the RPC method`,
  while the relay's real explanation sat several `.cause` levels deep where
  nobody found it. The submit path now extracts that reason and throws with
  it up front — e.g. `The relay rejected the request to prepare the call:
  fee token not supported: 0x…` — keeping the original error on `.cause`.
  Fee-token requests get an extra hint that relay fees are paid in the
  native currency (BNB), not `$U`. The execute and errors docs document the
  fee model. No behavior change to successful calls. (#72)

- **`@altananetwork/x402-server`: a payment whose receipt could not be read is
  no longer reported as failed.** When the settlement transaction was broadcast
  but the RPC failed to return its receipt (error or timeout), the merchant
  answered 402 "settlement failed" with a fresh challenge and forgot the
  authorization. Every x402 buyer answers a fresh challenge by signing a new
  authorization, so the buyer paid twice for one request, and the first
  transaction hash was discarded. Settlement now returns
  `settlement: "pending"` with the hash once a transaction is out, and the
  merchant answers 200 with that receipt; the same authorization sent again
  while pending is re-checked and answered with the same settlement instead of
  a replay rejection. The same classification applies when the broadcast
  response itself is lost and the node reports the transaction as already
  known. Receipt waits are bounded by the new `settleTimeoutMs` option
  (default 60s), `clients` lets a merchant inject its own viem clients, and
  settlement error text no longer embeds the facilitator's RPC URL.
  Reproduced and covered on a BNB-mainnet fork in `fork-x402-server`, which
  now runs in CI. Reported in #76.

## [0.9.0] - 2026-09-02

`@altananetwork/mcp` 0.9.0

### Added

- **`serializeSession` / `deserializeSession` — the safe way to persist a
  session.** `serializeSession(session)` returns a JSON-safe object with NO
  key material in it (spend limits as decimal strings);
  `deserializeSession(stored, signer)` rebuilds a signing session from the
  stored half plus the key the caller kept, and refuses a signer that
  doesn't match the session's registered public key — a mixed-up key now
  fails loudly at restore instead of opaquely at execute. The MCP server's
  three hand-rolled session restores now go through `deserializeSession`.
  `grantSession` also warns (once per process) when called without a
  `sessionSigner`: the SDK-generated key exists only in process memory, and
  losing it strands the on-chain authorization it backs. (#58)

- **ERC-8183 seller support — an Altana agent can now get paid, not just
  pay.** `submitErc8183Deliverable` submits a hired job's finished work
  (wallet or session path; pre-flight reads turn the kernel's opaque
  reverts into clear errors), `buildSubmitCall` is the low-level builder,
  and `erc8183SubmitPermissions(chainId)` scopes a seller session to
  exactly `submit()` on the commerce kernel. The deliverable-manifest codec
  ships too: `encodeErc8183Manifest` / `erc8183ManifestHash` produce the
  canonical form byte-identical to the Python reference — including the
  `\uXXXX` escaping of non-ASCII content that a plain `JSON.stringify`
  gets wrong and that breaks cross-language hash verification — and
  `verifyErc8183ManifestText` is the buyer-side raw-bytes integrity check.
  Exposed in the MCP server as `erc8183_submit`, which returns the exact
  canonical text the agent must serve at its deliverable URL. The fork e2e
  now drives the full two-sided lifecycle (hire → submit → verify →
  settle → seller paid) against real kernel bytecode. (#59)

### Changed

- **`SignerType` no longer advertises `"injected"`.** The union member
  promised browser-wallet (MetaMask) signing that was never implemented and
  is blocked by the wallets themselves: extension wallets withhold the
  EIP-7702 delegation authorization and refuse to sign the raw relay
  digests, so the runtime has rejected `"injected"` since day one. The type
  now matches reality (`"privateKey" | "passkey"`; compile-time-only change
  — no working code used it), the helpful runtime message stays, and a new
  guide, *Onboard users from browser wallets*, documents the flow that
  works: connect MetaMask/Trust Wallet/Rabby as usual, create the account
  with `createPasskeyWallet`, and fund it in one click through the
  connected wallet's own provider. (#56)

- **A signer's private key can no longer be captured by JSON.** The docs
  used to say "persist the `Session` object verbatim" — advice that threw
  on bigint spend limits, silently wrote the raw session key into storage,
  and dropped the signing function. The internal key field is now
  non-enumerable, so `JSON.stringify`/`Object.keys` never see it. Anyone
  who relied on the leak for persistence must migrate to
  `serializeSession`/`deserializeSession` plus their own key storage; the
  docs' session-persistence guidance is rewritten everywhere it appeared.
  (#58)

- **Documented the EIP-7702 native-payout limitation.** Contracts that pay
  the wallet native coin via `.transfer()`/`.send()` revert: the 2300-gas
  stipend cannot run the wallet's delegated account code. Known case: Venus
  core-pool vBNB `redeem` on BNB Chain. ERC-20 payouts and full-gas
  `call{value:}` payouts are unaffected. The errors and execute pages now
  cover the symptom and the workarounds (wrapped-token path, gateway
  contracts, plain-EOA receiver), and a fork test pins the behavior against
  the real mainnet account bytecode. Root cause is in the paying contract,
  so there is no SDK-side fix. (#55)

### Fixed

- **The SDK's last Node-only API is gone.** `getErc8183DeliverableUrl`
  decoded event bytes with `Buffer`, which does not exist in browsers or
  React Native without a polyfill; it now uses viem's runtime-neutral
  `hexToString` (behavior-parity verified, including NUL padding and
  invalid UTF-8). The passkey guard messages also stopped blaming only
  "Node or other server runtimes" — they now name React Native and point
  at the `webAuthn` option. (#65)

- **Relay rejections no longer hang for four minutes as `PENDING`.** The
  status poller only understood relay codes 200 and 500; a bundle the relay
  rejected before inclusion (code 300 — most commonly a session spend cap
  too small to also cover the relay fee, which the cap must) fell through
  the loop for the full 240-second deadline and then came back as
  `PENDING`, for a bundle that was already dead on the first poll. Statuses
  are now classified by the EIP-5792 bands (1xx in flight, 2xx confirmed,
  300–699 failed; unknown codes keep polling rather than risking a
  duplicate resubmission), so a rejection returns `FAILED` within seconds.
  Results gain an optional `statusCode` with the relay's raw code — on
  `FAILED` it separates "rejected before the chain" from "reverted
  on-chain", and on a timed-out `PENDING` it separates "genuinely still in
  flight" from "the relay never answered". The docs now carry the status
  code table and a grantSession warning that the native spend cap also
  pays relay fees. Note the behavior change: flows that used to see
  `PENDING` after 240 s for rejected bundles now see `FAILED` fast. (#57)

- **BSC testnet (chain 97) hire flow no longer reverts.** The bundled
  `ERC8183_ADDRESSES[97].policy` pointed at an address that is not
  whitelisted on the testnet EvaluatorRouter, so every
  `hireErc8183Agent()` / `buildHireCalls()` run on BSC testnet reverted at
  `registerJob` with `PolicyNotWhitelisted()`. The entry now uses the
  deployed OptimisticPolicy (`0xd6a4217588F6B1F5657a92A3e94E6422aD771cEA`),
  verified against the operator's deployment manifest and live router
  whitelist state. Mainnet was unaffected. (#53)

### Added

- **Passkeys on native mobile: WebAuthn function injection.** `createPasskey`,
  `createPasskeyWallet`, `recoverFromPasskey`, and `signerFromPasskey` accept
  a `webAuthn: { createFn, getFn }` option for JavaScript runtimes without
  the browser WebAuthn API — React Native, Expo, Capacitor. The app passes
  its native passkey library's functions (which bridge to Apple's and
  Google's platform passkey APIs) and the SDK forwards them into porto
  everywhere WebAuthn is touched: credential creation, recovery, and every
  signature (each execute performs a fresh assertion ceremony). Outside a
  browser, `rpId` is required with a clear error (porto/ox would otherwise
  crash on the missing `window` mid-flow), and the option types avoid DOM
  globals so React Native tsconfigs typecheck. Browser behavior is
  unchanged when the option is absent. CI proves the forwarding with the
  same mock-function pattern porto's own tests use; real-device
  verification is invited from the field. (#65)

## [0.8.0] - 2026-08-18

### Added

- **ERC-8004 agent identity.** An agent on an Altana wallet can now mint and
  maintain its own on-chain identity, so buyers and other agents can discover
  it. `registerErc8004Agent` mints and returns the assigned `agentId`,
  `setErc8004AgentUri` publishes the registration record, and
  `getErc8004Agent` reads both back. `buildErc8004RegisterCall` /
  `buildErc8004SetAgentUriCall` are the underlying call builders, and
  `encodeErc8004AgentUri` / `decodeErc8004AgentUri` /
  `withErc8004Registration` handle the registration file — canonical JSON,
  byte-identical to `@bnbagent`'s TypeScript and Python SDKs, so records hash
  the same across ecosystems. Registry addresses come from the existing
  `ERC8183_ADDRESSES[chainId].registry`; there is no second address table.

  This closes the gap that forced BNB Agent Studio agents on Altana wallets to
  deploy with `--skip-register`.

- **`erc8004RegisterPermissions(chainId)`** — the bounded capability for the
  above: two `{ to, signature }` rules that let a session key call exactly
  `register` and `setAgentURI` on the registry. Deliberately not a
  `{ to: registry }` grant: a session executes as the wallet, which owns the
  identity token, so a registry-wide grant would also authorize
  `transferFrom`, `setApprovalForAll` (an operator approval that outlives the
  session's revocation), and `setAgentWallet`.

- **`erc8004_register`, `erc8004_set_agent_uri` and `erc8004_show` in the MCP
  server.** `erc8004_register` drives both registration phases; if the mint
  lands but the write-back fails it returns the `agentId` with repair
  instructions rather than stranding a minted identity that has no reverse
  lookup. All three check the session's permissions client-side before
  spending gas.

### Fixed

- **`hireErc8183Agent` no longer throws a false "job is not ours" error when
  `opts.noWait` is set.** With `noWait`, `execute()` returns
  `{ status: "PENDING" }` as soon as the relay accepts the intent — before the
  batch is mined — but the post-funding ownership check read chain state
  unconditionally, so it saw pre-inclusion state and failed on every `noWait`
  call. Worse, obeying the error's "retry" advice re-ran the hire batch and
  escrowed $U a second time for an already-funded job. The check now runs only
  once the result is `CONFIRMED`; `noWait` callers verify via `getErc8183Job`
  after their `callsId` confirms (the docstring documents this). First
  external contribution — thanks @web3xDev! (#42)

## [0.7.1] - 2026-08-12

`@altananetwork/mcp` 0.7.1

### Added

- **`grantSession` returns the grant's transaction hash.** The result is now
  `GrantSessionResult`, a `Session` plus an optional `transactionHash`. Granting
  is the one call that charges the user a Keystore registration fee (twice on a
  wallet's first admin action), and it was the only entry point that discarded
  the hash instead of forwarding it. `execute`, `revokeSession` and
  `registerSessionKey` were already returning it.
- **`grant_session` reports the transaction hash in the MCP server**, alongside
  the session details and `keyId`, matching every other write tool.

Not a breaking change: `GrantSessionResult` is assignable everywhere a `Session`
is expected. One thing to watch as a consumer, an explicit annotation narrows
the type back down and hides the new field:

```ts
const session: Session = await client.grantSession({ ... });
session.transactionHash;  // does not typecheck
```

Let the type be inferred, or annotate with `GrantSessionResult`.

## [0.7.0] - 2026-08-04

`@altananetwork/mcp` 0.7.0

### Added

- **Skills registry discovery in the MCP server.** `search_skills` searches the
  registry by name, description, and tags; `get_skill` fetches a skill's full
  playbook. Playbook content is integrity checked against the registry's
  `sha256` before it is returned, so a tampered playbook is rejected rather
  than followed.

### Fixed

- **B402 envelope compatibility.** The x402 client and server now speak the
  B402 envelope dialect on both sides, fixing payments against BNB-chain
  sellers that expect it.

## [0.6.0] - 2026-07-16

`@altananetwork/mcp` 0.5.0

### Added

- **ERC-8183 buyer support.** Hire BNB Agent Studio seller agents from an
  Altana wallet: escrow, job status, and settlement as one atomic relay
  intent. Exposed through the SDK and as `erc8183_create_job`,
  `erc8183_job_status`, and `erc8183_settle` in the MCP server.
- **`@altananetwork/x402-server`.** Seller-side x402/B402 package: payment
  challenges, verification, and on-chain settlement.

## [0.5.0] - 2026-07-14

`@altananetwork/mcp` 0.4.0

### Added

- **BNB testnet support** (chain 97), routed through
  `testnet-relay.altana.network`.
- **Optional session-key Keystore registration.** `grantSession` takes a
  `register` flag, on by default; `registerSessionKey` registers a key later.
- **ERC-20 balances with BEP-677 support.** `client.balances` detects
  scaled-UI-amount tokens via ERC-165 and scales their display value, leaving
  the raw on-chain amount untouched.

## [0.4.0] - 2026-07-14

`@altananetwork/mcp` 0.3.0

### Added

- **x402 payments.** Pay HTTP payment challenges with a session key over
  Permit2 or EIP-3009, including the B402 permit2-exact witness rail.
- **ERC-1271 signature verification** for smart-account wallets.

## [0.3.3] - 2026-07-08

First public release: agentic wallets, session keys, the Keystore registry,
the MCP servers, and the documentation site.

[0.10.0]: https://github.com/altananetwork/altana-sdk/releases
[0.9.0]: https://github.com/altananetwork/altana-sdk/releases
[0.8.0]: https://github.com/altananetwork/altana-sdk/releases
[0.7.1]: https://github.com/altananetwork/altana-sdk/releases
[0.7.0]: https://github.com/altananetwork/altana-sdk/releases
[0.6.0]: https://github.com/altananetwork/altana-sdk/releases
[0.5.0]: https://github.com/altananetwork/altana-sdk/releases
[0.4.0]: https://github.com/altananetwork/altana-sdk/releases
[0.3.3]: https://github.com/altananetwork/altana-sdk/releases
