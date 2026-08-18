# Reviewing external PRs (maintainers)

The safety flow for pull requests from contributors we don't know yet. Scale
it to the change: the full ceremony below is for **code-touching PRs from
unknown contributors**; a docs typo gets a diff read and a merge.

## 1. Read the whole diff on GitHub — before any checkout

Never run untrusted code before reading it. Red flags that demand extra
scrutiny (or a second maintainer):

- Changes to `.github/workflows/**` (CI runs with repo permissions)
- `package.json` — new dependencies, changed `scripts`, install hooks
  (`postinstall` etc.)
- `bun.lock` changes, especially without a matching `package.json` change
- Base64/hex blobs, minified or obfuscated code
- New URLs, RPC endpoints, or network calls in shipped code
- New `process.env` reads in shipped code

## 2. Verify the claim, not the story

Reproduce the claimed bug against `staging` (read the relevant source or run
it) **before** trusting the fix. A plausible writeup around a subtly wrong
"fix" is the main attack shape.

## 3. Run it in isolation

```sh
git worktree add /tmp/pr-review origin/staging
cd /tmp/pr-review && gh pr checkout <PR#>
git diff origin/staging --stat -- bun.lock   # expect empty unless deps changed
bun install --frozen-lockfile
bun run typecheck && bun run build
cd packages/wallet && for f in src/*.test.ts src/internal/*.test.ts; do bun test "$f" || break; done
```

## 4. Prove new tests actually test the bug

Apply **only the PR's test file** to unpatched `staging` and run it — the new
tests must fail. A test that passes without the fix proves nothing:

```sh
git worktree add /tmp/pr-testproof origin/staging
cd /tmp/pr-testproof
git fetch origin pull/<PR#>/head
git checkout FETCH_HEAD -- path/to/changed.test.ts
bun test path/to/changed.test.ts   # expect failure
```

## 5. CI safety rules (standing)

- Never add a `pull_request_target` job that checks out PR code — it runs
  with secrets against attacker-controlled code.
- Secrets stay out of PR-triggered jobs (`fork-tests` is skipped on fork PRs
  for exactly this reason).
- Keep "require approval for workflow runs from outside collaborators"
  enabled in Actions settings.

## 6. Merge

External PRs merge into `staging` and ship to `main` with the next SDK
publish. `staging` → `main` is always a merge commit, never a squash.
