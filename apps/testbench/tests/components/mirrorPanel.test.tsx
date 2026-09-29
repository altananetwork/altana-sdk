import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CELO_SEPOLIA, type SerializedSession } from "@altananetwork/sdk";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MirrorPanel } from "../../src/components/MirrorPanel";
import type { StoredSession } from "../../src/lib/storage";
import { TEST_ADDRESS, TEST_KEY, fakeClient, mirrorCurrent } from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const SESSION_KEY = "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as const;
const SESSION_PUBLIC_KEY = privateKeyToAccount(SESSION_KEY).publicKey;
const OTHER_WALLET = "0x6A75e80B961f7d884f9D03E5Aa0808d05e47c50d" as const;
const KEY_ID = "0x26aaf13c72b195571d3d7587c9df471e3f0752fb297da285e961267ac898e87d" as const;

const serialized: SerializedSession = {
  walletAddress: TEST_ADDRESS,
  publicKey: SESSION_PUBLIC_KEY,
  permissions: { spend: [] },
  expiry: 2_000_000_000,
};

const session: StoredSession = {
  id: "s1",
  name: "agent one",
  serialized,
  sessionKey: SESSION_KEY,
  keyId: keccak256(SESSION_PUBLIC_KEY),
  legs: [],
  createdAt: 0,
  status: "granted",
};

describe("MirrorPanel", () => {
  test("nothing is read until a key is given", () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    expect(screen.getByText(/Pick or type a key/)).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });

  test("a key id typed for another wallet is read, and cannot be proven", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });

    await userEvent.type(screen.getByLabelText("Wallet"), OTHER_WALLET);
    await userEvent.type(screen.getByLabelText(/Key id or public key/), KEY_ID);

    await waitFor(() =>
      expect(client.readMirror).toHaveBeenCalledWith({
        chainId: CELO_SEPOLIA.chainId,
        user: OTHER_WALLET,
        keyId: KEY_ID,
      }),
    );
    expect(screen.getByText(/given as a key id, so it can be read but not proven/)).toBeInTheDocument();
  });

  test("a public key is hashed to its key id, and can be proven", async () => {
    const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
    });
    renderWith(client, <MirrorPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });

    await userEvent.type(screen.getByLabelText(/Key id or public key/), SESSION_PUBLIC_KEY);
    await waitFor(() =>
      expect(client.readMirror).toHaveBeenCalledWith(
        expect.objectContaining({ user: TEST_ADDRESS, keyId: keccak256(SESSION_PUBLIC_KEY) }),
      ),
    );
    expect(screen.getByText(/This key was given as a public key/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Prove into the Celo mirror" })).toBeEnabled();
  });

  test("a blank wallet field uses the wallet in this browser", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(screen.getByLabelText(/Key id or public key/), KEY_ID);
    await waitFor(() =>
      expect(client.readMirror).toHaveBeenCalledWith(expect.objectContaining({ user: TEST_ADDRESS })),
    );
  });

  test("a session from this browser can be picked, and brings its public key with it", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel />, { v: 1, walletKey: TEST_KEY, sessions: [session] });

    await userEvent.selectOptions(screen.getByLabelText(/A session from this browser/), "s1");
    await waitFor(() =>
      expect(client.readMirror).toHaveBeenCalledWith(
        expect.objectContaining({ user: TEST_ADDRESS, keyId: keccak256(SESSION_PUBLIC_KEY) }),
      ),
    );
    expect(screen.getByText(/This key was given as a public key/)).toBeInTheDocument();
    // Named in the picker and again on the card it selected.
    expect(screen.getAllByText("agent one").length).toBe(2);
  });

  test("junk in the key field is named rather than sent to the chain", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(screen.getByLabelText(/Key id or public key/), "not a key");
    expect(await screen.findByText(/That is not hex/)).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });

  test("a hex value that is neither a key id nor a public key is named", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(screen.getByLabelText(/Key id or public key/), "0xdeadbeef");
    expect(await screen.findByText(/neither a 32 byte key id nor a public key/)).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });

  test("a malformed wallet address is named and nothing is read", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(screen.getByLabelText("Wallet"), "0x123");
    await userEvent.type(screen.getByLabelText(/Key id or public key/), KEY_ID);
    expect(await screen.findByText("That is not an address.")).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });
});
