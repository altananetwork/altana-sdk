/**
 * Altana passkey wallet — browser demo.
 *
 * Walks through the v0 lifecycle hands-on:
 *   1. Real WebAuthn passkey (Touch ID / Face ID / Windows Hello / security
 *      key) → admin authority on a fresh smart account
 *   2. User funds the wallet from anywhere
 *   3. Passkey grants a scoped session key on-chain
 *   4. Session key (NOT the passkey) executes a 1-wei transfer — the agent
 *      path
 *   5. Passkey revokes the session
 *
 * Sepolia testnet. No deployer key in the browser — funding is the user's
 * responsibility (any wallet works).
 */

import {
  createClient,
  signerFromPasskey,
  createPrivateKeySigner,
  BNB,
  type PasskeyCredential,
} from "@altananetwork/sdk";
import { createPublicClient, formatEther, http, parseEther, type Address, type Hex } from "viem";

// One client, configured for BNB testnet. Add more chains here to make the
// same wallet usable across them.
const client = createClient({ chains: [BNB] });

// ---------- helpers ---------------------------------------------------------

const logEl = document.getElementById("log") as HTMLPreElement;

function log(msg: string, cls?: "ok" | "err") {
  const stamp = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${stamp}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function explorerTx(hash: string) {
  return `https://testnet.bscscan.com/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://testnet.bscscan.com/address/${addr}`;
}

function setText(id: string, html: string) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function show(id: string) {
  const el = document.getElementById(id);
  if (el) el.removeAttribute("hidden");
}

function setDisabled(id: string, disabled: boolean) {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  if (el) el.disabled = disabled;
}

// Light up a code snippet in the left pane to match the current step. Pass
// "active" to mark in-progress, "done" to mark completed, null to dim.
function markCode(id: string, state: "active" | "done" | null) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove("active", "done");
  if (state) el.classList.add(state);
}

function isAddress(x: string): x is Address {
  return /^0x[0-9a-fA-F]{40}$/.test(x);
}

// ---------- state -----------------------------------------------------------

const publicClient = createPublicClient({
  chain: BNB.chain,
  transport: http(BNB.publicRpcUrl),
});

let walletState: Awaited<ReturnType<typeof client.createPasskeyWallet>> | null = null;
let sessionState: Awaited<ReturnType<typeof client.grantSession>> | null = null;
let recipientForSession: Address | null = null;

// ---------- persistence -----------------------------------------------------

// Schema for what we stash in localStorage. The credential itself is plain
// JSON (no BigInts) since v0.x of @altananetwork/sdk, so the whole blob is just
// `JSON.stringify`-friendly. Private keys for the SESSION signer would be
// here too, but the demo regenerates sessions on each grant so we don't
// persist them — the app would for a real agent use case.
const STORAGE_KEY = "altana.passkey-demo.v1";

type StoredState = {
  credential: PasskeyCredential;
  walletAddress: Address;
};

function loadStored(): StoredState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredState;
  } catch {
    return null;
  }
}

function saveStored(state: StoredState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearStored() {
  localStorage.removeItem(STORAGE_KEY);
}

// ---------- step 1: create wallet ------------------------------------------

document.getElementById("btn-create")!.addEventListener("click", async () => {
  setDisabled("btn-create", true);
  markCode("code-create", "active");
  try {
    const name = (document.getElementById("wallet-name") as HTMLInputElement).value.trim()
      || "Altana Recovery 21";
    log(`Generating throwaway-EOA, prompting for passkey "${name}"…`);
    // createPasskeyWallet runs the sequence:
    //   1. throwaway-EOA → derives walletAddress
    //   2. WebAuthn passkey with walletAddress baked into userHandle
    //   3. EIP-7702 upgrade, throwaway signs, passkey is the lasting admin
    walletState = await client.createPasskeyWallet({
      name,
    });
    const passkey = walletState.signer;
    saveStored({ credential: passkey.credential, walletAddress: walletState.address });
    log(`Wallet ready: ${walletState.address}`, "ok");
    log(`Passkey carries walletAddress in userHandle — recoverable even if localStorage clears.`);
    markCode("code-create", "done");
    markCode("code-grant", "active");
    renderWalletReady();
    await refreshBalance();
  } catch (err) {
    log(`Create failed: ${err instanceof Error ? err.message : err}`, "err");
    setDisabled("btn-create", false);
  }
});

function renderWalletReady() {
  if (!walletState) return;
  setText(
    "wallet-addr",
    `<a href="${explorerAddr(walletState.address)}" target="_blank">${walletState.address}</a>`,
  );
  show("wallet-info");
  show("step-2");
  show("step-3");

  // Replace the create/recover row with a Reset link.
  const createBtn = document.getElementById("btn-create") as HTMLButtonElement;
  const recoverBtn = document.getElementById("btn-recover") as HTMLButtonElement;
  recoverBtn.style.display = "none";
  createBtn.textContent = "Wallet loaded — click to Reset";
  createBtn.classList.remove("secondary");
  createBtn.classList.add("link");
  createBtn.disabled = false;
  createBtn.onclick = () => {
    clearStored();
    location.reload();
  };
}

// ---------- recover from passkey -------------------------------------------

document.getElementById("btn-recover")!.addEventListener("click", async () => {
  setDisabled("btn-recover", true);
  setDisabled("btn-create", true);
  markCode("code-recover", "active");
  try {
    log("Prompting OS for a saved passkey (discoverable credential)…");
    walletState = await client.recoverFromPasskey();
    const passkey = walletState.signer;
    // Save what we recovered so subsequent loads are instant (no biometric).
    saveStored({ credential: passkey.credential, walletAddress: walletState.address });
    log(`Recovered wallet from passkey: ${walletState.address}`, "ok");
    markCode("code-recover", "done");
    markCode("code-grant", "active");
    renderWalletReady();
    await refreshBalance();
    // Recovery is literally a KeyStore read — surface what it just pulled.
    void surfaceKeyStoreRegistration();
  } catch (err) {
    log(`Recover failed: ${err instanceof Error ? err.message : err}`, "err");
    setDisabled("btn-recover", false);
    setDisabled("btn-create", false);
  }
});

// ---------- on load: rehydrate from localStorage ---------------------------

function rehydrate() {
  const stored = loadStored();
  if (!stored) return;
  log(`Found saved wallet ${stored.walletAddress.slice(0, 10)}… — restoring.`);
  const passkey = signerFromPasskey(stored.credential);
  walletState = {
    address: stored.walletAddress,
    signer: passkey,
  };
  renderWalletReady();
  refreshBalance().catch(() => {});
  // If KeyStore already has an entry for this wallet (i.e., the wallet's
  // first admin action already happened), show it so the demo is
  // consistent on reload.
  void surfaceKeyStoreRegistration();
}

// ---------- balance refresh -------------------------------------------------

async function refreshBalance() {
  if (!walletState) return;
  const bal = await publicClient.getBalance({ address: walletState.address });
  setText("wallet-balance", `${formatEther(bal)} ETH`);
}

document.getElementById("btn-refresh")!.addEventListener("click", refreshBalance);

// ---------- KeyStore on-chain proof ----------------------------------------

const KEYSTORE_ABI = [
  {
    name: "getKeys",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ type: "bytes32[]" }],
  },
  {
    name: "getPublicKey",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "keyId", type: "bytes32" },
    ],
    outputs: [{ type: "bytes" }],
  },
] as const;

async function surfaceKeyStoreRegistration() {
  if (!walletState) return;
  try {
    const keys = (await publicClient.readContract({
      address: BNB.keyStore,
      abi: KEYSTORE_ABI,
      functionName: "getKeys",
      args: [walletState.address],
    })) as readonly `0x${string}`[];

    if (keys.length === 0) {
      // Normal state if the wallet was created but hasn't run any admin
      // action yet — KeyStore registration is auto-prepended into the
      // first grant/execute, not the create itself.
      return;
    }
    const keyId = keys[0]!;
    const onchainPubKey = (await publicClient.readContract({
      address: BNB.keyStore,
      abi: KEYSTORE_ABI,
      functionName: "getPublicKey",
      args: [walletState.address, keyId],
    })) as `0x${string}`;

    setText(
      "ks-addr",
      `<a href="${explorerAddr(BNB.keyStore)}#readContract" target="_blank">${BNB.keyStore}</a>`,
    );
    setText("ks-keyid", keyId);
    setText(
      "ks-pubkey",
      `${onchainPubKey.slice(0, 24)}…${onchainPubKey.slice(-12)}`,
    );
    show("keystore-box");
    log(`KeyStore confirms admin key registered. keyId: ${keyId.slice(0, 18)}…`, "ok");
  } catch (err) {
    log(`KeyStore lookup failed: ${err instanceof Error ? err.message : err}`, "err");
  }
}

// ---------- step 3: live permission preview --------------------------------

function lifetimeLabel(seconds: number): string {
  if (seconds <= 3600) return "1 hour";
  if (seconds <= 86400) return "1 day";
  return "1 week";
}

function updatePermissionPreview() {
  const recipient = (document.getElementById("recipient") as HTMLInputElement).value.trim();
  const cap = (document.getElementById("spend-cap") as HTMLInputElement).value.trim();
  const lifetime = Number((document.getElementById("lifetime") as HTMLSelectElement).value);
  setText(
    "ps-recipient",
    recipient && isAddress(recipient)
      ? `${recipient.slice(0, 10)}…${recipient.slice(-6)}`
      : "(paste a recipient address)",
  );
  setText("ps-cap", cap || "0.01");
  setText("ps-lifetime", lifetimeLabel(lifetime));
}

["recipient", "spend-cap", "lifetime"].forEach((id) => {
  document.getElementById(id)!.addEventListener("input", updatePermissionPreview);
  document.getElementById(id)!.addEventListener("change", updatePermissionPreview);
});

// ---------- step 3: grant session ------------------------------------------

document.getElementById("btn-grant")!.addEventListener("click", async () => {
  if (!walletState) return;
  setDisabled("btn-grant", true);
  try {
    const recipientInput = (document.getElementById("recipient") as HTMLInputElement).value.trim();
    if (!recipientInput || !isAddress(recipientInput)) {
      throw new Error("Recipient must be a 0x-prefixed 20-byte address.");
    }
    recipientForSession = recipientInput;

    const capInput = (document.getElementById("spend-cap") as HTMLInputElement).value.trim() || "0.01";
    const dailyCapWei = parseEther(capInput);
    const lifetimeSec = Number((document.getElementById("lifetime") as HTMLSelectElement).value);

    log(
      `Granting session: send to ${recipientForSession.slice(0, 10)}…, ` +
        `${capInput} ETH/day cap, ${lifetimeLabel(lifetimeSec)} lifetime. Passkey will prompt…`,
    );

    sessionState = await client.grantSession({
      wallet: walletState,
      signer: walletState.signer,
      // The session signer is a fresh SDK-generated private key. In a real
      // agent flow, the dev's server holds this; the user never sees it.
      sessionSigner: createPrivateKeySigner(),
      permissions: {
        // Allow-list of (contract, function) rules. With just `to`, any
        // call to this address is allowed. The smart-account contract
        // rejects anything outside this list at validation time.
        calls: [{ to: recipientForSession }],
        // Rolling-window spend cap on the native token (ETH).
        spend: [{ limit: dailyCapWei, period: "day" }],
      },
      expiry: Math.floor(Date.now() / 1000) + lifetimeSec,
    });
    log("Session granted on-chain. Wallet contract now enforces the rules.", "ok");
    markCode("code-grant", "done");
    markCode("code-execute", "active");

    setText("session-pk", sessionState.signer.publicKey);
    setText("grant-tx", "(see logs)");
    show("session-info");
    show("step-4");

    // Surface the auto-prepended KeyStore registration that landed in this
    // same tx. This is what `recoverFromPasskey()` reads — making it visible
    // here is the whole point: it proves recovery isn't magic, it's reading
    // public on-chain state.
    void surfaceKeyStoreRegistration();
  } catch (err) {
    log(`Grant failed: ${err instanceof Error ? err.message : err}`, "err");
  } finally {
    setDisabled("btn-grant", false);
  }
});

// ---------- step 4: execute as session -------------------------------------

document.getElementById("btn-execute")!.addEventListener("click", async () => {
  if (!sessionState || !recipientForSession) return;
  setDisabled("btn-execute", true);
  try {
    log("Session signing & submitting 1-wei transfer (no biometric prompt — the session key signs).");
    const result = await client.execute({
      session: sessionState,
      calls: {
        to: recipientForSession,
        value: 1n,
        data: "0x",
      },
    });
    setText("exec-status", result.status);
    if (result.transactionHash) {
      setText(
        "exec-tx",
        `<a href="${explorerTx(result.transactionHash)}" target="_blank">${result.transactionHash}</a>`,
      );
      log(`Session executed: ${result.transactionHash}`, "ok");
      markCode("code-execute", "done");
      markCode("code-revoke", "active");
    } else {
      log(`Session execute status: ${result.status} (callsId ${result.callsId})`);
    }
    show("exec-info");
    show("step-5");
    await refreshBalance();
  } catch (err) {
    log(`Execute failed: ${err instanceof Error ? err.message : err}`, "err");
  } finally {
    setDisabled("btn-execute", false);
  }
});

// ---------- step 5: revoke -------------------------------------------------

document.getElementById("btn-revoke")!.addEventListener("click", async () => {
  if (!walletState || !sessionState) return;
  setDisabled("btn-revoke", true);
  try {
    log("Revoking session. Passkey will prompt to sign the revoke…");
    const result = await client.revokeSession({
      wallet: walletState,
      signer: walletState.signer,
      session: sessionState,
    });
    setText("revoke-status", result.status);
    if (result.transactionHash) {
      setText(
        "revoke-tx",
        `<a href="${explorerTx(result.transactionHash)}" target="_blank">${result.transactionHash}</a>`,
      );
      log(`Session revoked: ${result.transactionHash}`, "ok");
      markCode("code-revoke", "done");
    } else {
      log(`Revoke status: ${result.status} (callsId ${result.callsId})`);
    }
    show("revoke-info");
  } catch (err) {
    log(`Revoke failed: ${err instanceof Error ? err.message : err}`, "err");
  } finally {
    setDisabled("btn-revoke", false);
  }
});

log("Ready. Click 'Create wallet with passkey' to begin.");
markCode("code-create", "active");
rehydrate();
