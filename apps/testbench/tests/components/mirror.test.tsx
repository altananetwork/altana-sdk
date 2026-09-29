import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CELO_SEPOLIA, SEPOLIA } from "@altananetwork/sdk";
import { MirrorCard } from "../../src/components/MirrorCard";
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
        callsId: "0x01" as const,
        status: "CONFIRMED" as const,
        transactionHash: "0xproof" as const,
        cachedKey: {} as never,
        l1BlockNumber: mirrorCurrent.anchorL1Block,
        keyStoreCache: "0xB1002cE9d25F25b431AD22BF74667B7E8c04deeD" as const,
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
      wallet: TEST_ADDRESS,
      publicKey: PUBLIC_KEY,
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
