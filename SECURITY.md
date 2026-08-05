# Security policy

Altana handles signing keys and on-chain authorization. We take reports
seriously and we would rather hear about a suspected issue than not.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub:
[Report a vulnerability](https://github.com/altananetwork/altana-sdk/security/advisories/new).
This opens a private advisory visible only to you and the maintainers.

Helpful things to include, as far as you have them:

- What the issue lets an attacker do, and who is affected.
- The package and version (for example `@altananetwork/sdk@0.7.0`), plus the
  chain and contract addresses if the issue is on-chain.
- Steps to reproduce, or a minimal script.

We aim to acknowledge a report within three business days and to keep you
updated while we work on it. If you would like credit in the advisory, say so
and we will include you.

## Scope

In scope:

- `@altananetwork/sdk`, `@altananetwork/mcp`, `@altananetwork/x402-server`, and
  `@altananetwork/hypersigner-keystore-mcp`.
- The KeyStore contracts and their deployments, listed under
  [Networks and addresses](https://docs.altana.network/concepts/networks).

Out of scope:

- The demo apps under `apps/`, which exist to illustrate the SDK and are not
  production software.
- Findings that require a compromised machine, a leaked private key, or a
  malicious dependency already installed by the user.

## Handling keys

Altana is non-custodial. The SDK never persists or transmits a private key, and
custody stays with the signer the integrator supplies. If you find any path
where key material leaves the process it was created in, treat that as a
high-severity report.

## Audits

The KeyStore contracts were audited by CertiK, completed 15 July 2026. The
report and the status of every finding are published on
[CertiK Skynet](https://skynet.certik.com/projects/altana). See
[Audit reports](https://docs.altana.network/security/audits) for scope and the
verified deployments.
