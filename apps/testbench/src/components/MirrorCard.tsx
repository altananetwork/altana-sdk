import { useCallback, useEffect, useState } from "react";
import { keccak256, type Hex } from "viem";
import { chainName } from "../lib/chains";
import { addressUrl, txUrl } from "../lib/explorer";
import {
  canPopulate,
  minutesUntilProvable,
  mirrorState,
  mirrorSummary,
  type MirrorReading,
  type MirrorState,
  type MirrorTarget,
} from "../lib/mirror";
import { cachedNetworkFor, mirrorTargetsOf } from "../lib/mirrorReads";
import { relayReason } from "../lib/errors";
import { sameAddress } from "../lib/format";
import { useApp, useEnsureRegistered } from "../state/AppState";
import { Address as Addr } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";

/**
 * Altana's own explorer, which shows KeyStore keys and their cache proofs.
 * The route is `/account/`, not `/address/`: the latter answers 404 (checked
 * live, 2026-09-29).
 */
const ALTANA_EXPLORER = "https://testnet.altana.network";

export function altanaExplorerAccountUrl(address: string): string {
  return `${ALTANA_EXPLORER}/account/${address}`;
}

function badgeFor(state: MirrorState) {
  switch (state.kind) {
    case "current":
      return <Badge tone="success">Valid in the Celo mirror</Badge>;
    case "revoked":
      return <Badge tone="error">Revoked in the Celo mirror</Badge>;
    case "expired":
      return <Badge tone="error">Timebox passed</Badge>;
    case "provable":
      return <Badge tone="accent">Ready to prove</Badge>;
    case "stale":
      return <Badge tone="warning">Proven against an older block</Badge>;
    case "not-yet-provable":
      return <Badge tone="warning">Waiting for the Celo anchor</Badge>;
    case "never-registered":
      return <Badge>Not in the KeyStore</Badge>;
  }
}

function headline(state: MirrorState): string {
  switch (state.kind) {
    case "current":
      return "Valid on Celo, from Celo state alone";
    case "revoked":
      return "Revoked, and Celo can prove it";
    case "expired":
      return "The timebox has passed";
    case "provable":
      return state.wouldBeRevoked ? "The revocation can be proven now" : "The key can be proven now";
    case "stale":
      return "Proven, but against an older Ethereum block";
    case "not-yet-provable":
      return state.carries === "pre-revocation"
        ? "Celo has not yet anchored the revocation"
        : "Celo has not yet anchored the block this key was registered in";
    case "never-registered":
      return "No KeyStore entry for this key";
  }
}

export type MirrorCardProps = {
  /** The cached network whose mirror is read, for example Celo Sepolia. */
  chainId: number;
  target?: MirrorTarget;
  /** Hidden when the card is embedded in a step that already explains itself. */
  showTitle?: boolean;
};

/**
 * A live read of the Celo KeyStoreCache for one key, and the one action its
 * state allows.
 *
 * The cache answers for exactly one anchored Ethereum block, so the card never
 * shows a bare valid or not valid: every state says what is true, why, and
 * what happens next. Three of the five look like failures and are not
 * (evidence/2026-09-29-celo-sepolia-anchor-lag.md).
 */
export function MirrorCard({ chainId, target, showTitle = true }: MirrorCardProps) {
  const { state: app, client } = useApp();
  const ensureRegistered = useEnsureRegistered();
  const [reading, setReading] = useState<MirrorReading>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"reading" | "proving">();
  const [proofTx, setProofTx] = useState<{ hash?: Hex; status: string }>();

  const network = cachedNetworkFor(chainId);
  const user = target?.user;
  const keyId = target?.keyId;

  const refresh = useCallback(async () => {
    if (!user || !keyId || !network) return;
    setBusy("reading");
    setError(undefined);
    try {
      setReading(
        await client.readMirror({
          chainId,
          user,
          keyId,
          ...(target?.registrationL1Block !== undefined
            ? { registrationL1Block: target.registrationL1Block }
            : {}),
        }),
      );
    } catch (err) {
      setError(relayReason(err));
      setReading(undefined);
    } finally {
      setBusy(undefined);
    }
  }, [client, chainId, user, keyId, network, target?.registrationL1Block]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!network) {
    return (
      <div className="card">
        <p className="muted">
          {chainName(chainId, client.chains)} keeps its KeyStore locally, so it has no mirror to read. Only a
          cached network such as Celo Sepolia has one.
        </p>
      </div>
    );
  }

  const cacheAddress = (() => {
    try {
      return mirrorTargetsOf(network).cache;
    } catch {
      return undefined;
    }
  })();

  const state = reading ? mirrorState(reading) : undefined;
  // Proving needs a wallet to pay the Celo gas, and nothing more: populateKey
  // verifies a storage proof against the anchored L1 block and never looks at
  // msg.sender, so this browser can prove a key belonging to anyone. Confirmed
  // against the deployed cache by static-calling it from an unrelated address.
  // That is the point worth making on stage: anyone can verify, not only the
  // owner.
  const provingForSomeoneElse =
    app.wallet !== undefined && target !== undefined && !sameAddress(app.wallet.address, target.user);
  const canProve = state !== undefined && canPopulate(state) && target?.publicKey !== undefined && app.wallet !== undefined;

  async function prove() {
    if (!target?.publicKey || !app.wallet) return;
    setBusy("proving");
    setError(undefined);
    setProofTx(undefined);
    try {
      await ensureRegistered();
      const result = await client.proveIntoMirror({
        chainId,
        user: target.user,
        publicKey: target.publicKey,
        // This browser's wallet sends it and pays the Celo gas. It does not
        // have to own the key.
        payer: app.wallet.address,
        signer: app.wallet.signer,
      });
      setProofTx({ status: result.status, ...(result.transactionHash ? { hash: result.transactionHash } : {}) });
      await refresh();
    } catch (err) {
      setError(relayReason(err));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="card">
      {showTitle && <h3>Key in the Celo mirror</h3>}
      {!target && (
        <p className="muted">
          Pick or type a key to read its state in the Celo KeyStoreCache.
        </p>
      )}

      {target && (
        <div className="stack">
          <div className="row between">
            <div className="row" style={{ gap: 8 }}>
              <span className="muted small">Key</span>
              <Addr value={target.keyId} />
              {target.label && <span className="muted small">{target.label}</span>}
            </div>
            {state && badgeFor(state)}
          </div>

          {state && <p className="lead">{headline(state)}</p>}
          {state && <p>{mirrorSummary(state)}</p>}

          {state?.kind === "not-yet-provable" && (
            <p className="muted">
              Celo anchors Ethereum Sepolia block <span className="num">{String(reading!.anchorL1Block)}</span>
              {state.basis === "registration" ? (
                <>
                  , and this key needs{" "}
                  <span className="num">{String(reading!.registrationL1Block)}</span>, which is{" "}
                  <span className="num">{String(state.blocksBehind)}</span> further on.{" "}
                </>
              ) : (
                <>
                  , which is <span className="num">{String(state.blocksBehind)}</span> behind the Sepolia head (
                  <span className="num">{String(reading!.l1Head)}</span>). The registration block for this key is
                  not recorded, so this is the wait for Celo to reach Ethereum&apos;s head, which is the longest
                  it could be.{" "}
                </>
              )}
              {state.blocksBehind === 0n
                ? "The anchor is already at or past it, so the next anchor update should carry it. That is about every 20 minutes."
                : `The anchor advances about every 20 minutes, so expect about ${minutesUntilProvable(state.blocksBehind)} more minutes.`}
            </p>
          )}

          {state?.kind === "stale" && (
            <p className="muted">
              Proven against block <span className="num">{String(state.provenAt)}</span>; Celo now anchors{" "}
              <span className="num">{String(reading!.anchorL1Block)}</span>.
            </p>
          )}

          {reading && (
            <table className="table">
              <tbody>
                <tr>
                  <th scope="row">Anchored Ethereum block</th>
                  <td className="num">{String(reading.anchorL1Block)}</td>
                </tr>
                <tr>
                  <th scope="row">Ethereum Sepolia head</th>
                  <td className="num">{String(reading.l1Head)}</td>
                </tr>
                <tr>
                  <th scope="row">Proof in the cache was built at</th>
                  <td className="num">
                    {reading.cachedPresent ? String(reading.cachedSourceBlock) : "never proven"}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Cache isValidKey</th>
                  <td>{reading.cacheSaysValid ? "true" : "false"}</td>
                </tr>
              </tbody>
            </table>
          )}

          {target.publicKey === undefined && state && canPopulate(state) && (
            <div className="banner info">
              This key was entered as a key hash, so it can be read but not proven: populateKey takes the public
              key bytes and the cache checks that they hash to this key hash. Pick the key from the session
              history, or paste its public key, to send a proof.
            </div>
          )}

          {target.publicKey !== undefined && state && canPopulate(state) && !app.wallet && (
            <div className="banner info">
              Reading the mirror needs no wallet. Proving needs one, only to pay the Celo gas, so create or load
              a wallet to send the proof.
            </div>
          )}

          {provingForSomeoneElse && state && canPopulate(state) && (
            <p className="muted small">
              This key belongs to another wallet. This browser can still prove it: populateKey checks a storage
              proof against the anchored Ethereum block and never looks at who sent it, so anyone can put a key
              into the mirror, paying only the Celo gas.
            </p>
          )}

          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}

          {proofTx && (
            <div className={`banner ${proofTx.status === "CONFIRMED" ? "info" : "error"}`} role="status">
              Proof {proofTx.status.toLowerCase()}
              {proofTx.hash && (
                <>
                  {" "}
                  <a href={txUrl(chainId, proofTx.hash)} target="_blank" rel="noreferrer">
                    view the transaction
                  </a>
                </>
              )}
            </div>
          )}

          <div className="row">
            <Button onClick={() => void refresh()} disabled={busy !== undefined}>
              {busy === "reading" ? "Reading" : "Read the mirror again"}
            </Button>
            {state && canPopulate(state) && (
              <Button variant="primary" onClick={() => void prove()} disabled={!canProve || busy !== undefined}>
                {busy === "proving" ? "Proving" : "Prove into the Celo mirror"}
              </Button>
            )}
          </div>

          <div className="row" style={{ gap: 12 }}>
            {cacheAddress && (
              <a href={addressUrl(chainId, cacheAddress)} target="_blank" rel="noreferrer">
                The cache on Celoscan
              </a>
            )}
            <a href={altanaExplorerAccountUrl(target.user)} target="_blank" rel="noreferrer">
              The wallet on the Altana explorer
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/** A key hash from a pasted public key, so the card can read and prove it. */
export function targetFromPublicKey(user: MirrorTarget["user"], publicKey: Hex, label?: string): MirrorTarget {
  return { user, keyId: keccak256(publicKey), publicKey, ...(label ? { label } : {}) };
}
