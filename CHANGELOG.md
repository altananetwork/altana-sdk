# Changelog

Notable changes to `@altananetwork/sdk` and `@altananetwork/mcp`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions below are the `@altananetwork/sdk` version; the matching
`@altananetwork/mcp` version is noted where it differs.

These packages are pre-1.0. Minor versions may contain breaking changes.

> This changelog starts at 0.7.0. Entries for earlier versions were
> reconstructed from commit history after the fact, so they summarize what
> shipped rather than itemizing every change.

## [Unreleased]

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

[0.7.1]: https://github.com/altananetwork/altana-sdk/releases
[0.7.0]: https://github.com/altananetwork/altana-sdk/releases
[0.6.0]: https://github.com/altananetwork/altana-sdk/releases
[0.5.0]: https://github.com/altananetwork/altana-sdk/releases
[0.4.0]: https://github.com/altananetwork/altana-sdk/releases
[0.3.3]: https://github.com/altananetwork/altana-sdk/releases
