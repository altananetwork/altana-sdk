import { CELO_SEPOLIA, signerFromPrivateKey, type SessionLeg } from "@altananetwork/sdk";
import { useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, type Hex } from "viem";
import { chainName } from "../lib/chains";
import { relayReason } from "../lib/errors";
import { txUrl } from "../lib/explorer";
import { symbolFor } from "../lib/fees";
import { entry } from "../lib/log";
import { useApp } from "../state/AppState";
import { Address as Addr } from "./shared/Address";
import { Badge } from "./shared/Badge";
import { Button } from "./shared/Button";
import { Card } from "./shared/Card";
import { Field } from "./shared/Field";
import { LegsTable } from "./shared/LegsTable";

const CELO = CELO_SEPOLIA.chainId;

/**
 * A wallet whose admin authority is a passkey: create it, transact with it,
 * grant a session and revoke it.
 *
 * The thing worth seeing is that the wallet has **one address on every chain**.
 * It did not before #103: a cached network provisions two chains, and the
 * throwaway secp256k1 that stands in for the passkey's absent EOA was
 * generated per chain, so the address differed and createWallet refused. The
 * panel shows the address next to each configured chain for that reason.
 */
export function PasskeyPanel() {
  const { state: app, dispatch, client } = useApp();
  const [name, setName] = useState("Altana test bench");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [executed, setExecuted] = useState<{ status: string; hash?: Hex; charged?: string }>();
  const [granted, setGranted] = useState<{ keyId: Hex; status: string; legs: SessionLeg[] }>();
  const [revoked, setRevoked] = useState<{ status: string; legs: SessionLeg[] }>();
  const [sessionKey, setSessionKey] = useState<Hex>();

  const chains = client.chains;
  const wallet = app.wallet;
  const isPasskey = wallet?.kind === "passkey";
  const currencies = app.feeCurrenciesChainId === CELO ? (app.feeCurrencies ?? []) : [];

  async function guard(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      const reason = relayReason(err);
      setError(reason);
      dispatch({ type: "log/add", entry: entry(label, { error: reason, level: "error" }) });
    } finally {
      setBusy(undefined);
    }
  }

  const create = () =>
    guard("createPasskeyWallet", async () => {
      const result = await client.createPasskeyWallet({ name });
      dispatch({
        type: "wallet/setPasskey",
        passkey: { credential: result.signer.credential, address: result.address },
        registered: true,
      });
    });

  const recover = () =>
    guard("recoverFromPasskey", async () => {
      const result = await client.recoverFromPasskey();
      dispatch({
        type: "wallet/setPasskey",
        passkey: { credential: result.signer.credential, address: result.address },
        registered: true,
      });
    });

  const execute = () =>
    guard("execute", async () => {
      if (!wallet) return;
      const result = await client.execute({
        wallet: { address: wallet.address },
        signer: wallet.signer,
        chainId: CELO,
        calls: [{ to: wallet.address, value: 0n, data: "0x" }],
      });
      setExecuted({
        status: result.status,
        ...(result.transactionHash ? { hash: result.transactionHash } : {}),
        ...(result.feeToken ? { charged: symbolFor(result.feeToken, currencies) } : {}),
      });
    });

  const grant = () =>
    guard("grantSession", async () => {
      if (!wallet) return;
      const key = generatePrivateKey();
      setSessionKey(key);
      const result = await client.grantSession({
        wallet: { address: wallet.address },
        signer: wallet.signer,
        sessionSigner: signerFromPrivateKey(key),
        chainIds: [CELO],
        permissions: { spend: [{ limit: 10n ** 16n, period: "day" }] },
        expiry: Math.floor(Date.now() / 1000) + 3600,
      });
      setGranted({
        keyId: result.keyId ?? keccak256(privateKeyToAccount(key).publicKey),
        status: result.status,
        legs: result.legs ?? [],
      });
    });

  const revoke = () =>
    guard("revokeSession", async () => {
      if (!wallet || !sessionKey) return;
      const result = await client.revokeSession({
        wallet: { address: wallet.address },
        signer: wallet.signer,
        // revokeSession takes the public key directly and revokes everywhere
        // the key was granted, which here is Celo Sepolia only.
        session: privateKeyToAccount(sessionKey).publicKey,
      });
      setRevoked({ status: result.status, legs: result.legs ?? [] });
    });

  return (
    <div className="panel">
      <h2>Passkey wallet</h2>
      <p className="lead">
        A wallet whose admin authority is a passkey on this device. It has one address on every chain the relay
        serves, including the Ethereum Sepolia KeyStore chain behind Celo, so its registry writes go through its
        own account there.
      </p>

      <Card title="Create or recover">
        <div className="stack">
          <Field
            label="Name shown in the passkey prompt"
            htmlFor="pk-name"
            help="Your browser asks for a biometric. Nothing is on chain until the wallet's first transaction."
          >
            <input id="pk-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="row">
            <Button variant="primary" onClick={() => void create()} disabled={busy !== undefined}>
              {busy === "createPasskeyWallet" ? "Waiting for the passkey" : "Create a passkey wallet"}
            </Button>
            <Button onClick={() => void recover()} disabled={busy !== undefined}>
              Recover from an existing passkey
            </Button>
          </div>
          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
        </div>
      </Card>

      {wallet && (
        <Card title="The wallet">
          <div className="stack">
            <div className="row between">
              <Addr value={wallet.address} />
              {isPasskey ? (
                <Badge tone="success">Passkey</Badge>
              ) : (
                <Badge tone="warning">Private key, not a passkey</Badge>
              )}
            </div>
            {!isPasskey && (
              <div className="banner info">
                The wallet in use is a private key one. The actions below still work, but they do not show the
                passkey path. Create a passkey wallet above to replace it.
              </div>
            )}
            <table className="table">
              <tbody>
                {chains.map((c) => (
                  <tr key={c.chainId}>
                    <th scope="row">{chainName(c.chainId, chains)}</th>
                    <td>
                      <Addr value={wallet.address} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">
              The same address on each, which is what a passkey wallet could not do before: a passkey has no EOA,
              and the stand-in key used to be generated per chain.
            </p>
          </div>
        </Card>
      )}

      {wallet && (
        <Card title="Transact, grant and revoke">
          <div className="stack">
            <div className="row">
              <Button onClick={() => void execute()} disabled={busy !== undefined}>
                Execute on Celo Sepolia
              </Button>
              <Button onClick={() => void grant()} disabled={busy !== undefined}>
                Grant a session
              </Button>
              <Button variant="danger" onClick={() => void revoke()} disabled={busy !== undefined || !sessionKey}>
                Revoke it
              </Button>
            </div>

            {executed && (
              <div className="stack">
                <span className="muted small">Execute</span>
                <div className="row" style={{ gap: 8 }}>
                  <Badge tone={executed.status === "CONFIRMED" ? "success" : "error"}>{executed.status}</Badge>
                  {executed.charged && <span>Charged in {executed.charged}</span>}
                  {executed.hash && <Addr value={executed.hash} href={txUrl(CELO, executed.hash)} />}
                </div>
              </div>
            )}

            {granted && (
              <div className="stack">
                <span className="muted small">Session granted, signed by the passkey</span>
                <div className="row" style={{ gap: 8 }}>
                  <Badge tone={granted.status === "granted" ? "success" : "error"}>{granted.status}</Badge>
                  <Addr value={granted.keyId} />
                </div>
                <LegsTable legs={granted.legs} />
              </div>
            )}

            {revoked && (
              <div className="stack">
                <span className="muted small">Revoked</span>
                <Badge tone={revoked.status === "revoked" ? "success" : "error"}>{revoked.status}</Badge>
                <LegsTable legs={revoked.legs} />
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
