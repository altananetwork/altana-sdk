# Changelog

Notable changes to `@altananetwork/sdk` and `@altananetwork/mcp`.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions below are the `@altananetwork/sdk` version; the matching
`@altananetwork/mcp` version is noted where it differs.

These packages are pre-1.0. Minor versions may contain breaking changes.

> This changelog starts at 0.7.0. Entries for earlier versions were
> reconstructed from commit history after the fact, so they summarize what
> shipped rather than itemizing every change.

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
