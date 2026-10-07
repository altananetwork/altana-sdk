# Proving the agent half

Two scripts and one helper, for the part of the flow the app cannot test for
itself: what happens after the app shows a session key once and somebody pastes
it into their agent.

## The agent flow, through the real MCP

```bash
bun run agent:mcp          # live chain 97
```

On a fork, which is where an expiry can be moved and nothing real is spent:

```bash
wallet-harness/worktrees/backend/scripts/fork/start.sh --with-relay
set -a; source .fork/fork.env.out; set +a
AGENT_RPC_URL=$FORK_RPC_URL AGENT_RELAY_URL=$ALTANA_RELAY_URL bun run agent:mcp
```

Needs `TEST_FUNDER_KEY` from the shared `.env.testnet`. Exits non-zero if any
check fails, and prints a pass or fail line per check.

| Check | What it proves |
|---|---|
| A1 | the serialized half the app hands over carries no private key |
| A2 | the imported session reaches **the same on-chain key hash as the grant** |
| A3 | the agent's transaction lands, signed by the session |
| A4 | a spend over the limit is refused, with `ExceededSpendLimit` |
| A5 | the app can revoke |
| A6 | the revoked agent is refused, with `key hash … is unknown` |
| sweep | the leftover tBNB goes back to the funder |

A2 is the one that matters. Porto computes a key hash from the permissions and
the expiry, so a session rebuilt from a paste that differs in any way is a key
the relay has never heard of, and the failure appears much later as
`key hash unknown` with nothing pointing at the paste that caused it.

### It plays both sides on purpose

The script does what the app does, creating a passkey wallet, funding it and
granting a permission, and then hands the two halves to a **real**
`@altananetwork/mcp` process over stdio, exactly as a person pasting them would.
The server is started with **no admin key at all**, which is the premise: an
agent machine never has one.

### It stays out of your real key storage

The MCP is pointed at a temporary key store and a temporary `ALTANA_HOME`:

```
ALTANA_KEY_STORE=file:<tmp>/keys.json
ALTANA_HOME=<tmp>
```

Importing a session into a developer's actual login keychain would leave real
entries behind, and on macOS it can raise an access prompt no unattended run can
answer. The directory is removed when the run ends, so cleanup is complete
rather than best-effort. `ALTANA_KEY_STORE` is for automation only: a file holds
keys in plain text where the keychain encrypts them at rest.

### The revoke is retried once, visibly

The live relay occasionally fails a bundle for reasons unrelated to what is
under test. The retry is printed, because a suite that silently retries teaches
you to distrust it, and one that fails on a blip gets ignored.

## The credential screen's snippet, end to end

`agent-from-snippet.ts` answers a narrower question than the flow above: does
the command the wallet app prints, pasted by a person, produce an agent that
works?

It imports the app's own `buildMcpEnv` and `buildSnippet`, so the environment
under test is the one the screen renders rather than a copy of it living here.
A copy would pass forever while the screen printed something else, which is the
state this file exists to end.

```bash
ALTANA_APP_DIR=/path/to/altana-wallet \
  bun run tests/e2e/agent-from-snippet.ts

# on a fork
scripts/fork/start.sh --with-relay          # in the wallet app
set -a; source .fork/fork.env.out; set +a
AGENT_RPC_URL=$FORK_RPC_URL AGENT_RELAY_URL=$ALTANA_RELAY_URL \
  ALTANA_APP_DIR=/path/to/altana-wallet \
  bun run tests/e2e/agent-from-snippet.ts
```

`ALTANA_APP_DIR` points at a wallet app checkout holding `lib/agent-setup.ts`.
Wrong or missing, the run stops and says so: it never falls back to building the
variables itself, because that fallback is the gap.

### The command runs through a shell

The rendered command is executed by bash, with two substitutions and no others:
`claude mcp add` becomes `mcp-add-stub.ts`, which does what Claude Code does
with these arguments, and `bunx @altananetwork/mcp` becomes the server in this
repo, since the version that can import a session is not published yet.

Everything between those, every quote and every value, is the app's. That
matters because `ALTANA_SESSION` is JSON: unquoted, a shell eats its braces and
strips its quotes, and the server receives something that is not a session at
all. The stand-in writes down what it received and the test compares it to
`buildMcpEnv` byte for byte before anything else runs.

A session name is text somebody typed, so it is also the one value that could
carry a command substitution. Quoted correctly it arrives literally, and that is
checked on the app side.

## Returning leftover tBNB

```bash
# a wallet owned by a headless passkey
SWEEP_CREDENTIAL='{"kind":"headless","privateKey":"0x…","publicKey":"0x…"}' \
  bun run sweep -- 0xWalletAddress

# or by env var name, which is how .env.testnet stores credentials
SWEEP_CREDENTIAL_VAR=SMOKE_PASSKEY_E84E3EE8_CREDENTIAL \
  bun run sweep -- 0xWalletAddress

# a plain EOA-owned wallet
SWEEP_PRIVATE_KEY=0x… bun run sweep
```

It keeps back what the sweep itself costs, **read from the chain** rather than
fixed: a wallet that has never acted pays the KeyStore registration fee on its
first bundle, and that fee comes from a Chainlink feed that moves with the BNB
price. If the remainder is below that cost it says so and does nothing, because
moving it would cost more than it is worth.

A failure prints the relay's reason and says the funds are untouched, so a
transient relay failure does not read as lost money.

The credential is read from the environment and never printed.
