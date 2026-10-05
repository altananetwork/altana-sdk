import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CELO_SEPOLIA, SEPOLIA } from "@altananetwork/sdk";
import { MirrorCard, altanaExplorerAccountUrl } from "../../src/components/MirrorCard";
import type { MirrorTarget } from "../../src/lib/mirror";
import { TEST_ADDRESS, TEST_KEY, fakeClient, mirrorCurrent, packKey } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const PUBLIC_KEY =
  "0x04a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9" as const;
const KEY_ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

const withKey: MirrorTarget = { user: TEST_ADDRESS, keyId: KEY_ID, publicKey: PUBLIC_KEY, label: "session key" };
const readOnly: MirrorTarget = { user: TEST_ADDRESS, keyId: KEY_ID };

function setup(reading: Partial<typeof mirrorCurrent>, target: MirrorTarget = withKey, chainId = CELO_SEPOLIA.chainId) {
  const client = fakeClient({ readMirror: vi.fn(async () => ({ ...mirrorCurrent, ...reading })) });
  const r = renderWith(client, <MirrorCard chainId={chainId} target={target} />, {
    v: 1,
    walletKey: TEST_KEY,
    sessions: [],
  });
  return { client, ...r };
}

describe("MirrorCard", () => {
  test("(c) valid for the current anchor: the state, the blocks behind it and no prove button", async () => {
    setup({});
    expect(await screen.findByText("Valid in the Celo mirror")).toBeInTheDocument();
    // The headline and the sentence under it both say it, which is the point.
    expect(screen.getAllByText(/from Celo state alone/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(String(mirrorCurrent.anchorL1Block)).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Prove into the Celo mirror/ })).not.toBeInTheDocument();
  });

  test("(a) not yet provable: shown as progress with a wait, never as an error", async () => {
    setup({ livePacked: packKey(), anchorPacked: 0n, cachedPresent: false, cachedSourceBlock: 0n, anchorL1Block: 11807636n, l1Head: 11807694n });
    expect(await screen.findByText("Waiting for the Celo anchor")).toBeInTheDocument();
    expect(screen.getByText(/normal half-hour wait, not a failure/)).toBeInTheDocument();
    // 58 blocks behind is two anchor jumps, so about 40 minutes.
    expect(screen.getByText(/about 40 more minutes/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Prove into the Celo mirror/ })).not.toBeInTheDocument();
  });

  test("(a) a revocation the anchor has not reached keeps the button off", async () => {
    setup({ livePacked: packKey({ revoked: true }), anchorPacked: packKey(), cachedSourceBlock: 11807600n });
    expect(await screen.findByText(/waits for the next anchor/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Prove into the Celo mirror/ })).not.toBeInTheDocument();
  });

  test("(b) provable: the button sends the proof and the card re-reads", async () => {
    const client = fakeClient({
      readMirror: vi
        .fn()
        .mockResolvedValueOnce({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n, cacheSaysValid: false })
        .mockResolvedValue(mirrorCurrent),
      proveIntoMirror: vi.fn(async () => ({
        status: "CONFIRMED",
        transactionHash: "0xproof" as const,
        l1BlockNumber: mirrorCurrent.anchorL1Block,
        attempts: 1,
      })),
    });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });

    const button = await screen.findByRole("button", { name: "Prove into the Celo mirror" });
    await userEvent.click(button);

    await waitFor(() => expect(client.proveIntoMirror).toHaveBeenCalled());
    expect(vi.mocked(client.proveIntoMirror).mock.calls[0]![0]).toMatchObject({
      chainId: CELO_SEPOLIA.chainId,
      user: TEST_ADDRESS,
      publicKey: PUBLIC_KEY,
      payer: TEST_ADDRESS,
    });
    expect(await screen.findByText(/Proof confirmed/)).toBeInTheDocument();
    // It re-read, and the card now shows the key valid.
    expect(await screen.findByText("Valid in the Celo mirror")).toBeInTheDocument();
  });

  test("(d) proven against an older anchor: it says so, and offers to prove again", async () => {
    setup({ cachedSourceBlock: 11807607n });
    expect(await screen.findByText("Proven against an older block")).toBeInTheDocument();
    // Named in the sentence and again in the table row for the cached proof.
    expect(screen.getAllByText(/11807607/).length).toBe(2);
    expect(screen.getByRole("button", { name: "Prove into the Celo mirror" })).toBeEnabled();
  });

  test("revoked in the mirror, once the proof carries the revocation", async () => {
    setup({ livePacked: packKey({ revoked: true }), anchorPacked: packKey({ revoked: true }), cachedRevoked: true, cacheSaysValid: false });
    expect(await screen.findByText("Revoked in the Celo mirror")).toBeInTheDocument();
  });

  test("a key given as a key hash reads but cannot prove, and says why", async () => {
    setup({ cachedPresent: false, cachedSourceBlock: 0n }, readOnly);
    expect(await screen.findByText(/it can be read but not proven/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prove into the Celo mirror" })).toBeDisabled();
  });

  test("a read that fails shows the relay's own words, not a blank card", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => {
        throw new Error("The Ethereum Sepolia RPC would not read the KeyStore at block 11807636");
      }),
    });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/would not read the KeyStore at block 11807636/);
  });

  test("a chain with no mirror says so instead of reading one", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorCard chainId={SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    expect(await screen.findByText(/keeps its KeyStore locally/)).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });

  test("a failed proof is never reported as a success", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
      proveIntoMirror: vi.fn(async () => {
        throw new Error("relay rejected: intent reverted: 0x");
      }),
    });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Prove into the Celo mirror" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/intent reverted/);
    expect(screen.queryByText(/Proof confirmed/)).not.toBeInTheDocument();
  });
});

describe("MirrorCard, proving a key this browser does not own", () => {
  const OTHER = "0x6A75e80B961f7d884f9D03E5Aa0808d05e47c50d" as const;

  test("another wallet's key can be proven, paid by this browser's wallet", async () => {
    // populateKey verifies a storage proof against the anchored L1 block and
    // never looks at msg.sender. Confirmed against the deployed cache by
    // static-calling it from an unrelated address (2026-10-05), which is what
    // makes the showcase keys provable from the bench at all.
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
    });
    renderWith(
      client,
      <MirrorCard chainId={CELO_SEPOLIA.chainId} target={{ ...withKey, user: OTHER }} />,
      { v: 1, walletKey: TEST_KEY, sessions: [] },
    );

    const button = await screen.findByRole("button", { name: "Prove into the Celo mirror" });
    expect(button).toBeEnabled();
    expect(screen.getByText(/never looks at who sent it/)).toBeInTheDocument();

    await userEvent.click(button);
    await waitFor(() => expect(client.proveIntoMirror).toHaveBeenCalled());
    const sent = vi.mocked(client.proveIntoMirror).mock.calls[0]![0];
    // Whose key, and who pays, are different addresses.
    expect(sent.user).toBe(OTHER);
    expect(sent.payer).toBe(TEST_ADDRESS);
  });

  test("the browser's own key says nothing about relaying", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
    });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    await screen.findByRole("button", { name: "Prove into the Celo mirror" });
    expect(screen.queryByText(/never looks at who sent it/)).not.toBeInTheDocument();
  });

  test("with no wallet the read still works, and proving says why it needs one", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
    });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, { v: 1, sessions: [] });
    await waitFor(() => expect(client.readMirror).toHaveBeenCalled());
    expect(await screen.findByText(/only to pay the Celo gas/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prove into the Celo mirror" })).toBeDisabled();
  });
});

describe("the explorer links", () => {
  test("the Altana explorer route is /account/, which is the one that resolves", async () => {
    // /address/ answers 404 on testnet.altana.network (checked live 2026-09-29).
    expect(altanaExplorerAccountUrl(TEST_ADDRESS)).toBe(
      `https://testnet.altana.network/account/${TEST_ADDRESS}`,
    );
  });

  test("the card links the wallet to Altana's explorer and the cache to Celoscan", async () => {
    setup({});
    const altana = await screen.findByRole("link", { name: /Altana explorer/ });
    expect(altana).toHaveAttribute("href", `https://testnet.altana.network/account/${TEST_ADDRESS}`);
    const celoscan = screen.getByRole("link", { name: /cache on Celoscan/ });
    expect(celoscan).toHaveAttribute(
      "href",
      "https://sepolia.celoscan.io/address/0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD",
    );
  });
});

describe("the wait the card quotes", () => {
  /** qa's exact screen: anchor 11847825, head 11847917, A registered at 11847826. */
  const waiting = {
    livePacked: packKey(),
    anchorPacked: 0n,
    cachedPresent: false,
    cachedSourceBlock: 0n,
    anchorL1Block: 11847825n,
    l1Head: 11847917n,
  };

  test("a key one block from provable is not told to wait eighty minutes", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, ...waiting, registrationL1Block: 11847826n })),
    });
    renderWith(
      client,
      <MirrorCard
        chainId={CELO_SEPOLIA.chainId}
        target={{ ...withKey, registrationL1Block: 11847826n }}
      />,
      { v: 1, walletKey: TEST_KEY, sessions: [] },
    );
    expect(await screen.findByText(/this key needs/)).toBeInTheDocument();
    expect(screen.getByText(/about 20 more minutes/)).toBeInTheDocument();
    expect(screen.queryByText(/80 more minutes/)).not.toBeInTheDocument();
    // And the headline names the block the key needs, not Ethereum's head.
    expect(screen.getByText(/has not yet anchored the block this key was registered in/)).toBeInTheDocument();
  });

  test("the registration block is passed to the read, so the estimate can use it", async () => {
    const client = fakeClient();
    renderWith(
      client,
      <MirrorCard chainId={CELO_SEPOLIA.chainId} target={{ ...withKey, registrationL1Block: 11847826n }} />,
      { v: 1, walletKey: TEST_KEY, sessions: [] },
    );
    await waitFor(() =>
      expect(client.readMirror).toHaveBeenCalledWith(
        expect.objectContaining({ registrationL1Block: 11847826n }),
      ),
    );
  });

  test("without a registration block it says so, rather than quoting a wait as if it knew", async () => {
    const client = fakeClient({ readMirror: vi.fn(async () => ({ ...mirrorCurrent, ...waiting })) });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    expect(await screen.findByText(/registration block for this key is not recorded/)).toBeInTheDocument();
    expect(screen.getByText(/longest it could be/)).toBeInTheDocument();
  });

  test("an anchor already past the registration block says the next update carries it", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, ...waiting, registrationL1Block: 11847800n })),
    });
    renderWith(
      client,
      <MirrorCard chainId={CELO_SEPOLIA.chainId} target={{ ...withKey, registrationL1Block: 11847800n }} />,
      { v: 1, walletKey: TEST_KEY, sessions: [] },
    );
    expect(await screen.findByText(/next anchor update should carry it/)).toBeInTheDocument();
    expect(screen.queryByText(/more minutes/)).not.toBeInTheDocument();
  });

  test("the sentence that stops people thinking it is broken is untouched", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, ...waiting, registrationL1Block: 11847826n })),
    });
    renderWith(
      client,
      <MirrorCard chainId={CELO_SEPOLIA.chainId} target={{ ...withKey, registrationL1Block: 11847826n }} />,
      { v: 1, walletKey: TEST_KEY, sessions: [] },
    );
    expect(
      await screen.findByText(/would prove its absence and the cache would reject it/),
    ).toBeInTheDocument();
    expect(screen.getByText(/normal half-hour wait, not a failure/)).toBeInTheDocument();
  });
});

describe("what the card shows while and after proving", () => {
  test("a moving anchor reads as progress, not as an error", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
      proveIntoMirror: vi.fn(async (opts) => {
        opts.onStatus?.({ kind: "anchor-moved", attempt: 1, from: 100n, to: 101n, waitingMs: 60_000 });
        return { status: "CONFIRMED", transactionHash: "0xproof" as const, l1BlockNumber: 101n, attempts: 2 };
      }),
    });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Prove into the Celo mirror" }));
    expect(await screen.findByText(/Proof confirmed against Ethereum block 101/)).toBeInTheDocument();
    expect(screen.getByText(/after 2 attempts, the anchor having moved/)).toBeInTheDocument();
    // Never an alert: the anchor moving is expected, not a failure.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("the proof transaction hash is shown in full, not hidden behind a link", async () => {
    // qa could not record the hash for the write-up: the card linked it as
    // "view the transaction" and never showed the value.
    const hash = "0x4f169ce080ebad5ab5ef5a571de93f91dd18e9cbc60aed8d7279d0b949f644f5" as const;
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
      proveIntoMirror: vi.fn(async () => ({
        status: "CONFIRMED",
        transactionHash: hash,
        l1BlockNumber: 11848101n,
        attempts: 1,
      })),
    });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Prove into the Celo mirror" }));
    expect(await screen.findByTitle(hash)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: new RegExp(hash.slice(0, 10)) })).toHaveAttribute(
      "href",
      `https://sepolia.celoscan.io/tx/${hash}`,
    );
    expect(screen.getByRole("button", { name: new RegExp(`Copy ${hash}`) })).toBeInTheDocument();
  });

  test("a cache revert is explained in words, not left as a blob", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
      proveIntoMirror: vi.fn(async () => {
        throw new Error("execution reverted: Cache: cannot un-revoke");
      }),
    });
    renderWith(client, <MirrorCard chainId={CELO_SEPOLIA.chainId} target={withKey} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    await userEvent.click(await screen.findByRole("button", { name: "Prove into the Celo mirror" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/a revocation is permanent/);
  });
});
