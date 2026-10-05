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

/** No showcase file: the older tests are about the typed and picked paths. */
const noShowcase = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

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
    renderWith(client, <MirrorPanel fetchImpl={noShowcase} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    expect(screen.getByText(/Pick or type a key/)).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });

  test("a key id typed for another wallet is read, and cannot be proven", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel fetchImpl={noShowcase} />, { v: 1, walletKey: TEST_KEY, sessions: [] });

    await userEvent.type(screen.getByLabelText("Wallet"), OTHER_WALLET, { delay: null });
    await userEvent.type(screen.getByLabelText(/Key id or public key/), KEY_ID, { delay: null });

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
    renderWith(client, <MirrorPanel fetchImpl={noShowcase} />, { v: 1, walletKey: TEST_KEY, sessions: [] });

    await userEvent.type(screen.getByLabelText(/Key id or public key/), SESSION_PUBLIC_KEY, { delay: null });
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
    renderWith(client, <MirrorPanel fetchImpl={noShowcase} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(screen.getByLabelText(/Key id or public key/), KEY_ID, { delay: null });
    await waitFor(() =>
      expect(client.readMirror).toHaveBeenCalledWith(expect.objectContaining({ user: TEST_ADDRESS })),
    );
  });

  test("a session from this browser can be picked, and brings its public key with it", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel fetchImpl={noShowcase} />, { v: 1, walletKey: TEST_KEY, sessions: [session] });

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
    renderWith(client, <MirrorPanel fetchImpl={noShowcase} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(screen.getByLabelText(/Key id or public key/), "not a key");
    expect(await screen.findByText(/That is not hex/)).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });

  test("a hex value that is neither a key id nor a public key is named", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel fetchImpl={noShowcase} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(screen.getByLabelText(/Key id or public key/), "0xdeadbeef");
    expect(await screen.findByText(/neither a 32 byte key id nor a public key/)).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });

  test("a malformed wallet address is named and nothing is read", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel fetchImpl={noShowcase} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(screen.getByLabelText("Wallet"), "0x123");
    await userEvent.type(screen.getByLabelText(/Key id or public key/), KEY_ID, { delay: null });
    expect(await screen.findByText("That is not an address.")).toBeInTheDocument();
    expect(client.readMirror).not.toHaveBeenCalled();
  });
});

describe("MirrorPanel, the showcase keys", () => {
  const SHOWCASE_PK = `0x04${"ab".repeat(64)}` as const;
  const SHOWCASE_USER = "0xb5D3c1436eE76aCa1ecBd54BB27823488A26FD85" as const;

  const FILE = {
    updated: "2026-10-05",
    keys: [
      {
        role: "A-valid",
        label: "showcase A: valid, prove on demand",
        demoNote: "Registered and anchored before the demo, deliberately not proven.",
        user: SHOWCASE_USER,
        publicKey: SHOWCASE_PK,
        keyStoreKeyId: keccak256(SHOWCASE_PK),
        keyType: 2,
      },
      {
        role: "B-revoked",
        label: "showcase B: valid, then revoked",
        demoNote: "The pair.",
        user: TEST_ADDRESS,
        publicKey: `0x04${"cd".repeat(64)}`,
        keyStoreKeyId: keccak256(`0x04${"cd".repeat(64)}`),
        revocationTx: "0xrevoked",
        keyType: 2,
      },
    ],
  };

  /** The showcase file this test wants, injected rather than spied on. */
  function serving(body: unknown = FILE, status = 200) {
    return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  test("picking a showcase key reads its mirror, and it can be proven", async () => {
        const client = fakeClient({
      readMirror: vi.fn(async () => ({ ...mirrorCurrent, cachedPresent: false, cachedSourceBlock: 0n })),
    });
    renderWith(client, <MirrorPanel fetchImpl={serving()} />, { v: 1, walletKey: TEST_KEY, sessions: [] });

    await userEvent.selectOptions(await screen.findByLabelText(/A showcase key/), "A-valid");
    await waitFor(() =>
      expect(client.readMirror).toHaveBeenCalledWith(
        expect.objectContaining({ user: SHOWCASE_USER, keyId: keccak256(SHOWCASE_PK) }),
      ),
    );
    // It carries the public key, which is what keeps Prove live.
    expect(screen.getByText(/Registered and anchored before the demo/)).toBeInTheDocument();
    expect(screen.getByText(/prove and read in one go/)).toBeInTheDocument();
  });

  test("a revoked showcase key says revoked is the right answer, not a failure", async () => {
        renderWith(fakeClient(), <MirrorPanel fetchImpl={serving()} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.selectOptions(await screen.findByLabelText(/A showcase key/), "B-revoked");
    expect(screen.getByText(/revoked is the right answer here, not a failure/)).toBeInTheDocument();
  });

  test("a showcase key whose hashes disagree is left out, loudly", async () => {
    const broken = serving({ keys: [{ ...FILE.keys[0], keyStoreKeyId: keccak256("0xdeadbeef") }] });
    renderWith(fakeClient(), <MirrorPanel fetchImpl={broken} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    expect(await screen.findByRole("alert")).toHaveTextContent(/do not hold together/);
    expect(screen.queryByLabelText(/A showcase key/)).not.toBeInTheDocument();
  });

  test("no file at all leaves the tab exactly as it was", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel fetchImpl={serving(undefined, 404)} />, {
      v: 1,
      walletKey: TEST_KEY,
      sessions: [],
    });
    await waitFor(() => expect(screen.getByLabelText(/Key id or public key/)).toBeInTheDocument());
    expect(screen.queryByLabelText(/A showcase key/)).not.toBeInTheDocument();
  });

  test("a showcase key wins over what was typed, and hides the fields", async () => {
    const client = fakeClient();
    renderWith(client, <MirrorPanel fetchImpl={serving()} />, { v: 1, walletKey: TEST_KEY, sessions: [] });
    await userEvent.type(await screen.findByLabelText(/Key id or public key/), KEY_ID, { delay: null });
    await userEvent.selectOptions(screen.getByLabelText(/A showcase key/), "A-valid");
    await waitFor(() =>
      expect(client.readMirror).toHaveBeenLastCalledWith(
        expect.objectContaining({ keyId: keccak256(SHOWCASE_PK) }),
      ),
    );
    expect(screen.queryByLabelText(/Key id or public key/)).not.toBeInTheDocument();
  });
});
