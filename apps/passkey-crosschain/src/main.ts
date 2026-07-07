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
  ensureKeyCached,
  ETHEREUM,
  BASE,
  type EnsureKeyCachedStatus,
  type PasskeyCredential,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ---------- helpers ---------------------------------------------------------

const logEl = document.getElementById("log") as HTMLPreElement | null;

function log(msg: string, cls?: "ok" | "err") {
  if (cls === "err") console.error(msg);
  else console.log(msg);
  if (!logEl) return;
  const stamp = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${stamp}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function explorerTx(hash: string) {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}
function explorerAddr(addr: string) {
  return `https://sepolia.etherscan.io/address/${addr}`;
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
  chain: ETHEREUM.chain,
  transport: http(ETHEREUM.publicRpcUrl),
});

const l2PublicClient = createPublicClient({
  chain: BASE.chain,
  transport: http(BASE.publicRpcUrl),
});

const l2SignerKey = import.meta.env.VITE_BASE_SIGNER_KEY as Hex | undefined;
const l2WalletClient = l2SignerKey
  ? createWalletClient({
      account: privateKeyToAccount(l2SignerKey),
      chain: BASE.chain,
      transport: http(BASE.publicRpcUrl),
    })
  : null;

// Cross-chain here means the Sepolia L1 registry plus the Base Sepolia L2
// cache (ensureKeyCached), not a second L1 — so the client holds Sepolia.
const client = createClient({ chains: [ETHEREUM] });

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
}

// ---------- balance refresh -------------------------------------------------

async function refreshBalance() {
  if (!walletState) return;
  const bal = await publicClient.getBalance({ address: walletState.address });
  setText("wallet-balance", `${formatEther(bal)} ETH`);
}

document.getElementById("btn-refresh")!.addEventListener("click", refreshBalance);

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

    setText("grant-tx", "submitted");
    show("session-info");
    show("step-4");
    show("step-cross");
  } catch (err) {
    log(`Grant failed: ${err instanceof Error ? err.message : err}`, "err");
  } finally {
    setDisabled("btn-grant", false);
  }
});

// ---------- step 4: lazy activation on Base Sepolia -------------------------
//
// Option B: we don't sync at grant time. The first time the agent acts on
// Base, the SDK transparently anchors the L1 proof into the L2 cache. After
// that, every action is a local cache hit — instant.

function setBaseRow(state: "pending" | "active", html: string) {
  const row = document.getElementById("row-base");
  if (row) {
    row.classList.remove("pending", "active");
    row.classList.add(state);
  }
  setText("base-status-cell", html);
}

function setUseBaseButton(label: string | null, disabled: boolean) {
  const btn = document.getElementById("btn-use-base") as HTMLButtonElement | null;
  if (!btn) return;
  if (label === null) {
    btn.setAttribute("hidden", "");
    return;
  }
  btn.removeAttribute("hidden");
  btn.textContent = label;
  btn.disabled = disabled;
}

function showSyncBanner(stepText: string, titleText?: string) {
  const banner = document.getElementById("sync-banner");
  if (banner) banner.removeAttribute("hidden");
  setText("sync-banner-step", stepText);
  if (titleText) setText("sync-banner-title-text", titleText);
}

function hideSyncBanner() {
  const banner = document.getElementById("sync-banner");
  if (banner) banner.setAttribute("hidden", "");
}

function statusLabel(status: EnsureKeyCachedStatus): string {
  switch (status) {
    case "waiting-for-anchor":
      return "Waiting for Base to anchor the Ethereum block…";
    case "submitting-proof":
      return "Submitting the cryptographic proof to Base…";
    case "done":
      return "Activated.";
    case "cache-hit":
      return "Cache hit — already active on Base.";
  }
}

async function useOnBase() {
  if (!walletState || !sessionState) return;
  if (!l2WalletClient) {
    setBaseRow("pending", "Missing L2 signer in .env.local");
    log(
      "Missing VITE_BASE_SIGNER_KEY in apps/passkey-crosschain/.env.local.",
      "err",
    );
    return;
  }

  setUseBaseButton("Activating…", true);
  setBaseRow("pending", `Activating<span class="dots"></span>`);

  let bannerShown = false;
  try {
    await ensureKeyCached({
      l1Client: publicClient as never,
      l2Client: l2PublicClient as never,
      l2WalletClient: l2WalletClient as never,
      l1KeyStore: ETHEREUM.keyStore,
      l2Cache: BASE.keyStoreCache,
      user: walletState.address,
      publicKey: sessionState.signer.publicKey,
      onStatus: (status) => {
        log(`Base activation: ${status}`);
        if (status === "cache-hit") {
          // Already active — no banner needed.
          return;
        }
        if (status === "waiting-for-anchor" || status === "submitting-proof") {
          bannerShown = true;
          showSyncBanner(statusLabel(status));
        } else if (status === "done") {
          hideSyncBanner();
        }
      },
    });
    setBaseRow(
      "active",
      `Active <em>· any contract can now call <code>isValidKey</code> and get true</em>`,
    );
    setUseBaseButton("Use again (instant)", false);
    if (bannerShown) {
      log("Session is live on Base Sepolia. Future actions are instant.", "ok");
    } else {
      log("Session was already active on Base — instant cache hit.", "ok");
    }
  } catch (err) {
    hideSyncBanner();
    const msg = err instanceof Error ? err.message : String(err);
    setBaseRow("pending", "Activation failed — try again");
    setUseBaseButton("Use on Base", false);
    log(`Base activation failed: ${msg}`, "err");
  }
}

document.getElementById("btn-use-base")!.addEventListener("click", useOnBase);

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
