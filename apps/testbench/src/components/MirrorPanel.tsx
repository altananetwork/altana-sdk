import { CELO_SEPOLIA } from "@altananetwork/sdk";
import { useMemo, useState } from "react";
import { keccak256, type Hex } from "viem";
import { targetFromInput, type MirrorTarget } from "../lib/mirror";
import { useDebounced } from "../lib/useDebounced";
import { useApp } from "../state/AppState";
import { MirrorCard } from "./MirrorCard";

import { Field } from "./shared/Field";

const CELO = CELO_SEPOLIA.chainId;

/**
 * Picking which key's mirror to read.
 *
 * The showcase uses keys registered ahead of time, because a key registered
 * during a demo is not provable for about half an hour. So the card has to work
 * for a key that is typed in or picked out of this browser's session history,
 * not only for one the walkthrough just created.
 *
 * A key can be given two ways, and they are not equivalent:
 *
 * - its **public key**, which the card can read *and* prove, because
 *   `populateKey` takes the bytes and the cache checks they hash to the key id;
 * - its **key id** (the keccak256 of that), which the card can only read.
 *
 * The form says which one it got rather than failing at the relay later.
 */
export function MirrorPanel() {
  const { state: app } = useApp();
  const [walletInput, setWalletInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [picked, setPicked] = useState<string>("");

  const sessions = app.sessions;
  const wallet = app.wallet;

  const fromSession = useMemo<MirrorTarget | undefined>(() => {
    const session = sessions.find((s) => s.id === picked);
    if (!session) return undefined;
    const publicKey = session.serialized.publicKey;
    return {
      user: session.serialized.walletAddress,
      keyId: publicKey ? keccak256(publicKey) : (session.keyId as Hex),
      ...(publicKey ? { publicKey } : {}),
      label: session.name || "from this browser",
    };
  }, [picked, sessions]);

  // Debounced, so a public key typed or pasted a character at a time does not
  // read the chain for the wrong key on its way to the right one.
  const settledWallet = useDebounced(walletInput);
  const settledKey = useDebounced(keyInput);
  const typed = useMemo(
    () =>
      targetFromInput({
        wallet: settledWallet,
        key: settledKey,
        ...(wallet?.address ? { fallbackWallet: wallet.address } : {}),
      }),
    [settledWallet, settledKey, wallet?.address],
  );

  const target = picked ? fromSession : typed.target;
  const keyProblem = picked ? undefined : settledKey.trim() ? typed.keyProblem : undefined;
  const walletProblem = picked ? undefined : settledKey.trim() ? typed.walletProblem : undefined;

  return (
    <div className="panel">
      <h2>Celo mirror</h2>
      <p className="lead">
        A live read of the Celo KeyStoreCache for one key. The cache answers for exactly one anchored Ethereum
        block, which moves about every 20 minutes, so a key reads as not valid after each anchor update until it
        is proven again. Three of the states below look like failures and are not.
      </p>

      <div className="card">
        <h3>Which key</h3>
        <div className="stack">
          {sessions.length > 0 && (
            <Field
              label="A session from this browser"
              htmlFor="mirror-session"
              help="Sessions granted here keep their key, so these can be proven as well as read."
            >
              <select id="mirror-session" value={picked} onChange={(e) => setPicked(e.target.value)}>
                <option value="">Type one instead</option>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.keyId.slice(0, 12)}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {!picked && (
            <div className="row">
              <Field
                label="Wallet"
                htmlFor="mirror-wallet"
                help={wallet ? "Blank uses the wallet in this browser." : undefined}
                {...(walletProblem ? { error: walletProblem } : {})}
              >
                <input
                  id="mirror-wallet"
                  value={walletInput}
                  onChange={(e) => setWalletInput(e.target.value)}
                  placeholder={wallet?.address ?? "0x"}
                />
              </Field>
              <Field
                label="Key id or public key"
                htmlFor="mirror-key"
                help="Either one. A key id is 32 bytes."
                {...(keyProblem ? { error: keyProblem } : {})}
              >
                <input
                  id="mirror-key"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="0x"
                />
              </Field>
            </div>
          )}

          {target && (
            <p className="muted small">
              {target.publicKey
                ? "This key was given as a public key, so it can be read and proven."
                : "This key was given as a key id, so it can be read but not proven."}
            </p>
          )}
        </div>
      </div>

      <MirrorCard chainId={CELO} target={target} showTitle={false} />
    </div>
  );
}
