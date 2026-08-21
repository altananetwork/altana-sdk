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
  signerFromPrivateKey,
  createPrivateKeySigner,
  BNB_TESTNET,
  SEPOLIA,
  BASE_SEPOLIA,
  type PasskeyCredential,
} from "@altananetwork/sdk";
import {
  createPublicClient,
  formatEther,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";

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
  return `${selectedChain().explorer}/tx/${hash}`;
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

// Two executable chains the user can switch between. BNB testnet is full-stack
// (one chain does everything). Base Sepolia is a gated L2 — its authority lives
// on Sepolia and the SDK hides the L1 grant + L2 gate wiring + proof bridge.
const CHAINS: Record<number, typeof BNB_TESTNET | typeof BASE_SEPOLIA> = {
  [BNB_TESTNET.chainId]: BNB_TESTNET,
  [BASE_SEPOLIA.chainId]: BASE_SEPOLIA,
};
let selectedChainId: number = BASE_SEPOLIA.chainId;
const selectedChain = () => CHAINS[selectedChainId] ?? BASE_SEPOLIA;

// The SDK needs SEPOLIA in `chains` (to find Base Sepolia's L1 registry) and a
// funded relayer to pay the Base Sepolia proof-bridge gas. After this, the
// create/grant/execute code below is identical for both chains.
const l2SignerKey = import.meta.env.VITE_BASE_SEPOLIA_SIGNER_KEY as Hex | undefined;
const client = createClient({
  chains: [BNB_TESTNET, SEPOLIA, BASE_SEPOLIA],
  defaultChainId: BASE_SEPOLIA.chainId,
  ...(l2SignerKey
    ? { relayers: { [BASE_SEPOLIA.chainId]: signerFromPrivateKey(l2SignerKey) } }
    : {}),
});

// Read-only client for the currently selected chain (balances + canExecute).
const publicClient = () =>
  createPublicClient({
    chain: selectedChain().chain,
    transport: http(selectedChain().publicRpcUrl),
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

/**
 * Shows the balance on BOTH chains. The wallet needs Sepolia ETH to register the
 * session key in the L1 KeyStore, which is easy to miss if only one balance is
 * displayed - funding Base Sepolia looks like nothing happened.
 */
async function refreshBalance() {
  if (!walletState) return;
  const chain = selectedChain();
  const bal = await publicClient()
    .getBalance({ address: walletState.address })
    .catch(() => null);
  const fmt = (b: bigint | null) => (b === null ? "?" : formatEther(b));
  const isBase = selectedChainId === BASE_SEPOLIA.chainId;
  setText(
    "wallet-balance",
    `${fmt(bal)} ${chain.chain.nativeCurrency.symbol} on ${chain.chain.name}`,
  );

  const hint = document.getElementById("fund-hint");
  if (hint) {
    hint.textContent =
      bal !== null && bal === 0n
        ? isBase
          ? "Base Sepolia needs gas here, and the session grant also needs a little Sepolia (L1) ETH for the registry."
          : `Fund this address with ${chain.chain.nativeCurrency.symbol} on ${chain.chain.name}.`
        : "";
  }
}

const chainSelect = document.getElementById("chain-select") as HTMLSelectElement | null;
if (chainSelect) {
  chainSelect.value = String(selectedChainId);
  chainSelect.addEventListener("change", () => {
    selectedChainId = Number(chainSelect.value);
    log(`Switched to ${selectedChain().chain.name}.`);
    refreshBalance().catch(() => {});
  });
}

document.getElementById("btn-refresh")!.addEventListener("click", refreshBalance);

// Poll, so funding shows up without the user hunting for the refresh link.
setInterval(() => {
  refreshBalance().catch(() => {});
}, 5000);

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

    // IDENTICAL code for both chains. On BNB testnet this is a one-chain grant.
    // On Base Sepolia the SDK internally grants on the L1 (Sepolia), wires the
    // gate on the L2, and bridges the proof — the `onStatus` banner shows it —
    // but the call here is the same. permissions.calls[].to is routed to the
    // gate on Base and to the account allowlist on BNB.
    sessionState = await client.grantSession({
      wallet: walletState,
      signer: walletState.signer,
      // The session signer is a fresh SDK-generated private key. In a real
      // agent flow, the dev's server holds this; the user never sees it.
      sessionSigner: createPrivateKeySigner(),
      permissions: {
        calls: [{ to: recipientForSession }],
        spend: [{ limit: dailyCapWei, period: "day" }],
      },
      expiry: Math.floor(Date.now() / 1000) + lifetimeSec,
      chainId: selectedChainId,
      onStatus: (s) => log(`  activating on ${selectedChain().chain.name}: ${s}`),
    });
    log(
      sessionState.l2
        ? "Session granted, gate wired, and proof bridged — the SDK did it all."
        : "Session granted on-chain. Wallet contract now enforces the rules.",
      "ok",
    );
    markCode("code-grant", "done");
    markCode("code-execute", "active");

    setText("grant-tx", sessionState.transactionHash ?? "submitted");
    show("session-info");
    show("step-4");
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
    // Same call on both chains. On Base the SDK re-proves the L1 anchor if needed
    // before executing (auto-bridge); on BNB it's a plain execute.
    const result = await client.execute({
      session: sessionState,
      chainId: selectedChainId,
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
    // Revocation happens on the registry chain: BNB revokes on BNB; a gated L2
    // revokes on its L1 (Sepolia). On Base the L2 cache keeps reporting valid
    // until the next re-sync — L1 is the source of truth (auto re-sync of a
    // revoke on the L2 is a planned follow-up).
    const revokeChainId =
      selectedChainId === BASE_SEPOLIA.chainId
        ? SEPOLIA.chainId
        : selectedChainId;
    log(
      `Revoking session on ${selectedChain().chain.name}${
        revokeChainId !== selectedChainId ? " (registry on Sepolia)" : ""
      }. Passkey will prompt to sign the revoke…`,
    );
    const result = await client.revokeSession({
      wallet: walletState,
      signer: walletState.signer,
      session: sessionState,
      chainId: revokeChainId,
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
