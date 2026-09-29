import {
  CELO_SEPOLIA,
  NATIVE_TOKEN,
  SEPOLIA,
  signerFromPrivateKey,
  type SessionLeg,
} from "@altananetwork/sdk";
import { useEffect, useMemo, useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, type Address, type Hex } from "viem";
import { chainName } from "../lib/chains";
import { relayReason } from "../lib/errors";
import { txUrl } from "../lib/explorer";
import { nativeLabel, symbolFor } from "../lib/fees";
import { formatAmount } from "../lib/format";
import { entry } from "../lib/log";
import type { MirrorTarget } from "../lib/mirror";
import {
  canRun,
  dataOf,
  emptyWalkthrough,
  progress,
  setStep,
  STEP_BLURBS,
  STEP_ORDER,
  STEP_TITLES,
  type StepId,
  type StepState,
  type WalkthroughState,
} from "../lib/walkthrough";
import { useApp, useEnsureRegistered } from "../state/AppState";
import { MirrorCard } from "./MirrorCard";
import { Address as Addr } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";

const CELO = CELO_SEPOLIA.chainId;

function statusBadge(s: StepState["status"]) {
  switch (s) {
    case "done":
      return <Badge tone="success">Done</Badge>;
    case "running":
      return <Badge tone="accent">Running</Badge>;
    case "waiting":
      return <Badge tone="warning">Waiting</Badge>;
    case "failed":
      return <Badge tone="error">Failed</Badge>;
    case "blocked":
      return <Badge tone="warning">Blocked</Badge>;
    case "idle":
      return null;
  }
}

/**
 * The showcase screen: the one flow the Celo milestones have to prove, one
 * card per step with its live result.
 *
 * Step 4 fails on every live relay today for a known relay bug awaiting a
 * decision. The walkthrough shows the relay's own error and stops. It never
 * reports a step as done that did not happen.
 */
export function WalkthroughPanel() {
  const { state: app, dispatch, client } = useApp();
  const ensureRegistered = useEnsureRegistered();
  const [steps, setSteps] = useState<WalkthroughState>(emptyWalkthrough);
  const [feeToken, setFeeToken] = useState<string>("auto");
  const [recipient, setRecipient] = useState<string>("");
  // Step 4 makes the session key; step 6 uses and revokes it. Held here rather
  // than in the step's `data`, which is persisted and displayed.
  const [sessionKey, setSessionKey] = useState<Hex>();

  const chains = client.chains;
  const celoConfigured = chains.some((c) => c.chainId === CELO);
  const sepoliaConfigured = chains.some((c) => c.chainId === SEPOLIA.chainId);
  const currencies = app.feeCurrenciesChainId === CELO ? (app.feeCurrencies ?? []) : [];
  const native = nativeLabel(CELO, currencies, chains);
  const data = useMemo(() => dataOf(steps), [steps]);

  // The fee token choice is part of the showcase, so the walkthrough fetches
  // the relay's list itself rather than making the operator open another tab.
  useEffect(() => {
    if (!celoConfigured || app.feeCurrenciesChainId === CELO) return;
    let cancelled = false;
    void client
      .feeCurrencies(CELO)
      .then((r) => {
        if (!cancelled) dispatch({ type: "fees/set", chainId: CELO, currencies: r.currencies });
      })
      .catch(() => {
        // The Fee tokens tab reports this properly; here it only costs the
        // operator the token list, and "let the relay choose" still works.
      });
    return () => {
      cancelled = true;
    };
  }, [client, dispatch, celoConfigured, app.feeCurrenciesChainId]);

  const mirrorTarget: MirrorTarget | undefined = data.sessionKeyId
    ? {
        user: (data.walletAddress ?? app.wallet?.address) as Address,
        keyId: data.sessionKeyId,
        ...(data.sessionPublicKey ? { publicKey: data.sessionPublicKey } : {}),
        label: "from step 4",
      }
    : undefined;

  function update(id: StepId, patch: StepState) {
    setSteps((prev) => setStep(prev, id, patch));
  }

  function log(label: string, detail: string, level?: "error") {
    dispatch({
      type: "log/add",
      entry: entry(label, level === "error" ? { error: detail, level } : { result: detail }),
    });
  }

  /** Runs a step, recording the relay's own words on failure and never a false success. */
  async function runStep(id: StepId, fn: () => Promise<StepState>) {
    update(id, { status: "running" });
    try {
      const result = await fn();
      update(id, result);
      log(`walkthrough ${id}`, result.detail ?? result.status, result.status === "failed" ? "error" : undefined);
    } catch (err) {
      const reason = relayReason(err);
      update(id, { status: "failed", error: reason });
      log(`walkthrough ${id}`, reason, "error");
    }
  }

  const stepRunners: Record<StepId, () => Promise<StepState>> = {
    async create() {
      const wallet = app.wallet;
      if (!wallet) {
        return {
          status: "blocked",
          detail: "Create a wallet on the Wallet tab first, with a passkey or a private key.",
        };
      }
      await ensureRegistered();
      return {
        status: "done",
        detail:
          wallet.kind === "passkey"
            ? `Passkey wallet at ${wallet.address}, the same address on every chain the relay serves.`
            : `Private key wallet at ${wallet.address}. It is counterfactual until its first transaction.`,
        data: { walletAddress: wallet.address },
      };
    },

    async balances() {
      const wallet = app.wallet;
      if (!wallet) return { status: "blocked", detail: "No wallet." };
      const celo = await client.holdings(wallet.address, CELO);
      dispatch({ type: "holdings/set", chainId: CELO, holdings: celo });
      const held = [
        ...(celo.native > 0n ? [`${formatAmount(celo.native, 18)} ${native}`] : []),
        ...celo.tokens.flatMap((t) => (t.ok && t.raw > 0n ? [`${t.display} ${t.symbol}`] : [])),
      ];
      if (!sepoliaConfigured) {
        return {
          status: "done",
          detail: `On Celo Sepolia: ${held.join(", ") || "nothing yet"}. The relay in use does not serve Ethereum Sepolia, so its balance cannot be read from here.`,
        };
      }
      const sepolia = await client.holdings(wallet.address, SEPOLIA.chainId);
      const zeroEth = sepolia.native === 0n;
      return {
        status: "done",
        detail:
          `On Celo Sepolia: ${held.join(", ") || "nothing yet"}. On Ethereum Sepolia: ` +
          `${formatAmount(sepolia.native, 18)} ETH${zeroEth ? ", which is the point: every step after this is paid from Celo." : ". Not zero, so this run does not prove registration without ETH."}`,
        data: { sepoliaEth: sepolia.native },
      };
    },

    async pay() {
      const wallet = app.wallet;
      if (!wallet) return { status: "blocked", detail: "No wallet." };
      const to = (recipient.trim() || wallet.address) as Address;
      const chosen = feeToken === "auto" ? undefined : feeToken === "native" ? NATIVE_TOKEN : (feeToken as Address);
      const result = await client.execute({
        wallet: { address: wallet.address },
        signer: wallet.signer,
        chainId: CELO,
        calls: [{ to, value: 0n, data: "0x" }],
        ...(chosen ? { feeToken: chosen } : {}),
      });
      if (result.status !== "CONFIRMED") {
        return {
          status: "failed",
          error: `The relay returned ${result.status}${result.statusCode ? ` (${result.statusCode})` : ""}.`,
          ...(result.transactionHash
            ? { txs: [{ chainId: CELO, hash: result.transactionHash, label: "the attempt" }] }
            : {}),
        };
      }
      const charged = result.feeToken ? symbolFor(result.feeToken, currencies) : native;
      return {
        status: "done",
        detail: `Confirmed on Celo Sepolia. Charged in ${charged}.`,
        ...(result.transactionHash
          ? { txs: [{ chainId: CELO, hash: result.transactionHash, label: `charged in ${charged}` }] }
          : {}),
      };
    },

    async register() {
      const wallet = app.wallet;
      if (!wallet) return { status: "blocked", detail: "No wallet." };
      if (!sepoliaConfigured) {
        return {
          status: "blocked",
          detail:
            "The relay in use does not serve Ethereum Sepolia, so the KeyStore write cannot be made from here. Switch to a relay that does on the Settings tab.",
        };
      }
      const key = generatePrivateKey();
      setSessionKey(key);
      const sessionSigner = signerFromPrivateKey(key);
      const publicKey = privateKeyToAccount(key).publicKey;
      const grant = await client.grantSession({
        wallet: { address: wallet.address },
        signer: wallet.signer,
        sessionSigner,
        chainIds: [CELO],
        permissions: { spend: [{ limit: 10n ** 16n, period: "day" }] },
        expiry: Math.floor(Date.now() / 1000) + 3600,
        onStatus: (status, detail) => log(`grantSession ${status}`, chainName(detail?.chainId ?? CELO, chains)),
      });
      const legs = grant.legs ?? [];
      const registry = legs.find((l: SessionLeg) => l.kind === "registry");
      const failed = legs.filter((l: SessionLeg) => l.status === "FAILED");
      const txs = legs
        .filter((l: SessionLeg) => l.transactionHash)
        .map((l: SessionLeg) => ({ chainId: l.chainId, hash: l.transactionHash!, label: `${l.kind} leg` }));

      const keyId = grant.keyId ?? keccak256(publicKey);
      const common = { data: { sessionPublicKey: publicKey, sessionKeyId: keyId }, txs };

      if (grant.status !== "granted" || failed.length > 0) {
        return {
          ...common,
          status: "failed",
          error:
            failed.map((l: SessionLeg) => `${l.kind} on ${chainName(l.chainId, chains)}: ${l.reason ?? "failed"}`).join("; ") ||
            `grantSession returned ${grant.status}.`,
          detail:
            "This is the step that fails on every live relay today, for a relay bug awaiting a decision. The relay's own words are above.",
        };
      }
      return {
        ...common,
        status: "done",
        detail: registry?.fundedFromChainId
          ? `The Ethereum Sepolia write was paid from the wallet's balance on ${chainName(registry.fundedFromChainId, chains)}. The wallet still holds no ETH.`
          : "The session key is registered. The registry leg did not report which chain funded it.",
      };
    },

    async mirror() {
      const wallet = app.wallet;
      if (!wallet || !data.sessionKeyId) return { status: "blocked", detail: "Run step 4 first." };
      const reading = await client.readMirror({
        chainId: CELO,
        user: (data.walletAddress ?? wallet.address) as Address,
        keyId: data.sessionKeyId,
      });
      const behind = reading.l1Head - reading.anchorL1Block;
      if (reading.cachedPresent && reading.cachedSourceBlock === reading.anchorL1Block) {
        return {
          status: "done",
          detail: "Proven against the Ethereum block Celo anchors right now. The card below reads it live.",
        };
      }
      return {
        status: "waiting",
        detail: `Celo anchors Ethereum block ${reading.anchorL1Block}, ${behind} behind the Sepolia head. Use the card below: it says whether the key can be proven yet, and proves it when it can.`,
      };
    },

    async "use-and-revoke"() {
      const wallet = app.wallet;
      if (!wallet) return { status: "blocked", detail: "No wallet." };
      if (!sessionKey || !data.sessionPublicKey) {
        return { status: "blocked", detail: "Run step 4 first, so there is a session key to use." };
      }
      const publicKey = data.sessionPublicKey;
      const txs: { chainId: number; hash: Hex; label: string }[] = [];

      // Use it: a transaction signed by the session key, not the wallet key.
      const used = await client.execute({
        session: {
          walletAddress: wallet.address,
          signer: signerFromPrivateKey(sessionKey),
          publicKey,
          permissions: { spend: [{ limit: 10n ** 16n, period: "day" }] },
          expiry: Math.floor(Date.now() / 1000) + 3600,
        },
        chainId: CELO,
        calls: [{ to: wallet.address, value: 0n, data: "0x" }],
      } as never);
      if (used.transactionHash) {
        txs.push({ chainId: CELO, hash: used.transactionHash, label: "signed by the session key" });
      }
      if (used.status !== "CONFIRMED") {
        return {
          status: "failed",
          txs,
          error: `The session key's transaction returned ${used.status}.`,
        };
      }

      // Revoke it, everywhere it was granted.
      const revoked = await client.revokeSession({
        wallet: { address: wallet.address },
        signer: wallet.signer,
        session: publicKey,
      });
      const legs = revoked.legs ?? [];
      for (const leg of legs) {
        if (leg.transactionHash) {
          txs.push({ chainId: leg.chainId, hash: leg.transactionHash, label: `revoke, ${leg.kind} leg` });
        }
      }
      const failed = legs.filter((l: SessionLeg) => l.status === "FAILED");
      if (revoked.status !== "revoked" || failed.length > 0) {
        return {
          status: "failed",
          txs,
          error:
            failed.map((l: SessionLeg) => `${l.kind} on ${chainName(l.chainId, chains)}: ${l.reason ?? "failed"}`).join("; ") ||
            `revokeSession returned ${revoked.status}.`,
        };
      }
      return {
        status: "done",
        txs,
        detail:
          "The session key transacted, then the wallet revoked it on Ethereum. The mirror card above still shows the key as it was last proven: it carries the revocation only after Celo anchors an Ethereum block from after the revoke, about half an hour. Read the card again then.",
      };
    },
  };

  const { done, total, failed } = progress(steps);

  return (
    <div className="panel">
      <h2>Spine walkthrough</h2>
      <p className="lead">
        The one flow the Celo milestones have to prove: a wallet on Celo with no ETH anywhere pays its gas in a
        Celo token, registers its session key in the Ethereum Sepolia KeyStore out of its Celo balance, and that
        key is then readable, and later revoked, on Celo itself.
      </p>

      {!celoConfigured && (
        <div className="banner error" role="alert">
          Celo Sepolia is not configured for the relay in use. Pick a relay that serves it on the Settings tab.
        </div>
      )}

      <div className="row between">
        <span className="muted">
          {done} of {total} steps done{failed ? ", one failed" : ""}
        </span>
        <Button
          onClick={() => {
            setSteps(emptyWalkthrough());
          }}
        >
          Start again
        </Button>
      </div>

      <Card title="Before you start">
        <div className="row">
          <Field label="Fee token for step 3" htmlFor="wt-fee">
            <select id="wt-fee" value={feeToken} onChange={(e) => setFeeToken(e.target.value)}>
              <option value="auto">Let the relay choose</option>
              <option value="native">{native}</option>
              {currencies
                .filter((c) => !c.isNative)
                .map((c) => (
                  <option key={c.uid} value={c.address}>
                    {c.symbol}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="Recipient for step 3" htmlFor="wt-to" help="Defaults to the wallet itself.">
            <input id="wt-to" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="0x" />
          </Field>
        </div>
      </Card>

      {STEP_ORDER.map((id, index) => {
        const step = steps[id];
        return (
          <Card key={id}>
            <div className="row between">
              <h3>
                {index + 1}. {STEP_TITLES[id]}
              </h3>
              {statusBadge(step.status)}
            </div>
            <p className="hint">{STEP_BLURBS[id]}</p>

            {step.detail && <p>{step.detail}</p>}
            {step.error && (
              <div className="banner error" role="alert">
                {step.error}
              </div>
            )}
            {step.txs && step.txs.length > 0 && (
              <ul className="stack">
                {step.txs.map((t) => (
                  <li key={t.hash} className="row" style={{ gap: 8 }}>
                    <span className="muted small">{chainName(t.chainId, chains)}</span>
                    <Addr value={t.hash} href={txUrl(t.chainId, t.hash)} />
                    <span className="muted small">{t.label}</span>
                  </li>
                ))}
              </ul>
            )}

            {id === "mirror" && <MirrorCard chainId={CELO} target={mirrorTarget} showTitle={false} />}

            <div className="row">
              <Button
                variant={index === 0 ? "primary" : "secondary"}
                disabled={!canRun(steps, id) || step.status === "running"}
                onClick={() => void runStep(id, stepRunners[id])}
              >
                {step.status === "running" ? "Running" : step.status === "done" ? "Run again" : "Run this step"}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
