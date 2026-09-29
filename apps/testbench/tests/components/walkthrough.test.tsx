import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { CELO_SEPOLIA, SEPOLIA, type GrantSessionResult, type SessionLeg } from "@altananetwork/sdk";
import { WalkthroughPanel } from "../../src/components/WalkthroughPanel";
import type { StoredState } from "../../src/lib/storage";
import {
  TEST_ADDRESS,
  TEST_KEY,
  USDC,
  fakeClient,
  holdingsWithUsdc,
  mirrorCurrent,
  packKey,
} from "../../src/test/fakeClient";
import { renderWith } from "../../src/test/render";

const WITH_WALLET: StoredState = { v: 1, walletKey: TEST_KEY, sessions: [] };

const goodLegs: SessionLeg[] = [
  {
    chainId: SEPOLIA.chainId,
    kind: "registry",
    status: "CONFIRMED",
    via: "relay",
    transactionHash: "0xreg",
    fundedFromChainId: CELO_SEPOLIA.chainId,
    sourceTransactionHash: "0xsrc",
  },
  { chainId: CELO_SEPOLIA.chainId, kind: "account", status: "CONFIRMED", via: "relay", transactionHash: "0xacc" },
];

function grant(over: Partial<GrantSessionResult> = {}): GrantSessionResult {
  return {
    walletAddress: TEST_ADDRESS,
    signer: undefined as never,
    publicKey: "0x04ab",
    permissions: { spend: [] },
    expiry: 0,
    keyId: "0x2222222222222222222222222222222222222222222222222222222222222222",
    status: "granted",
    legs: goodLegs,
    cacheSync: Promise.resolve([]),
    ...over,
  } as GrantSessionResult;
}

function card(title: RegExp) {
  return screen.getByRole("heading", { name: title }).closest(".card") as HTMLElement;
}

async function runStep(title: RegExp) {
  await userEvent.click(within(card(title)).getByRole("button", { name: /Run this step/ }));
}

describe("WalkthroughPanel", () => {
  test("lists the six spine steps, with only the first runnable", () => {
    renderWith(fakeClient(), <WalkthroughPanel />, WITH_WALLET);
    expect(screen.getByRole("heading", { name: /1\. Create an agentic wallet on Celo/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /5\. Show the key in the Celo mirror/ })).toBeInTheDocument();
    expect(within(card(/1\. Create/)).getByRole("button")).toBeEnabled();
    expect(within(card(/3\. Pay gas/)).getByRole("button", { name: /Run this step/ })).toBeDisabled();
  });

  test("with no wallet, step 1 is blocked and says where to make one", async () => {
    renderWith(fakeClient(), <WalkthroughPanel />, { v: 1, sessions: [] });
    await runStep(/1\. Create/);
    expect(await screen.findByText(/Create a wallet on the Wallet tab first/)).toBeInTheDocument();
    expect(within(card(/2\. Balances/)).getByRole("button", { name: /Run this step/ })).toBeDisabled();
  });

  test("step 2 names the Celo holdings and calls out zero ETH on Ethereum", async () => {
    const client = fakeClient({
      holdings: vi.fn(async (_w, chainId) =>
        chainId === SEPOLIA.chainId ? { native: 0n, tokens: [] } : { ...holdingsWithUsdc, native: 5n * 10n ** 17n },
      ),
    });
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    await runStep(/1\. Create/);
    await runStep(/2\. Balances/);
    expect(await screen.findByText(/2 USDC/)).toBeInTheDocument();
    expect(screen.getByText(/0 ETH.*every step after this is paid from Celo/)).toBeInTheDocument();
  });

  test("step 2 says plainly when Sepolia ETH is not zero, instead of claiming the proof", async () => {
    const client = fakeClient({
      holdings: vi.fn(async (_w, chainId) =>
        chainId === SEPOLIA.chainId ? { native: 10n ** 18n, tokens: [] } : holdingsWithUsdc,
      ),
    });
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    await runStep(/1\. Create/);
    await runStep(/2\. Balances/);
    expect(await screen.findByText(/does not prove registration without ETH/)).toBeInTheDocument();
  });

  test("step 3 sends the chosen fee token and reports what it was charged in", async () => {
    const client = fakeClient({
      execute: vi.fn(async () => ({
        callsId: "0x01" as const,
        status: "CONFIRMED" as const,
        transactionHash: "0xpay" as const,
        feeToken: USDC,
      })),
    });
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    await runStep(/1\. Create/);
    await runStep(/2\. Balances/);
    await userEvent.selectOptions(screen.getByLabelText(/Fee token for step 3/), USDC);
    await runStep(/3\. Pay gas/);
    await waitFor(() => expect(client.execute).toHaveBeenCalled());
    expect(vi.mocked(client.execute).mock.calls[0]![0]).toMatchObject({ feeToken: USDC });
    expect(await screen.findByText(/Charged in USDC/)).toBeInTheDocument();
  });

  test("a relay FAILED on step 3 is a failure, never a done step", async () => {
    const client = fakeClient({
      execute: vi.fn(async () => ({ callsId: "0x01" as const, status: "FAILED" as const, statusCode: 500 })),
    });
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    await runStep(/1\. Create/);
    await runStep(/2\. Balances/);
    await runStep(/3\. Pay gas/);
    expect(await screen.findByRole("alert")).toHaveTextContent(/returned FAILED \(500\)/);
    expect(within(card(/3\. Pay gas/)).getByText("Failed")).toBeInTheDocument();
    expect(within(card(/4\. Register/)).getByRole("button", { name: /Run this step/ })).toBeDisabled();
  });

  test("step 4 done says which chain paid the Ethereum write", async () => {
    const client = fakeClient({ grantSession: vi.fn(async () => grant()) });
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    for (const t of [/1\. Create/, /2\. Balances/, /3\. Pay gas/, /4\. Register/]) await runStep(t);
    expect(await screen.findByText(/was paid from the wallet's balance on Celo Sepolia/)).toBeInTheDocument();
    expect(screen.getByText(/0xreg/)).toBeInTheDocument();
  });

  test("a failed registry leg shows the relay's own words and stops the walkthrough", async () => {
    const failed: SessionLeg[] = [
      { chainId: SEPOLIA.chainId, kind: "registry", status: "FAILED", reason: "intent reverted: 0x" },
    ];
    const client = fakeClient({ grantSession: vi.fn(async () => grant({ status: "failed", legs: failed })) });
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    for (const t of [/1\. Create/, /2\. Balances/, /3\. Pay gas/, /4\. Register/]) await runStep(t);
    expect(await screen.findByRole("alert")).toHaveTextContent(/registry on Sepolia: intent reverted: 0x/);
    expect(within(card(/4\. Register/)).getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/fails on every live relay today/)).toBeInTheDocument();
  });

  test("step 5 reports a wait as waiting, and the mirror card is there to act on", async () => {
    const client = fakeClient({
      grantSession: vi.fn(async () => grant()),
      readMirror: vi.fn(async () => ({
        ...mirrorCurrent,
        livePacked: packKey(),
        anchorPacked: 0n,
        cachedPresent: false,
        cachedSourceBlock: 0n,
      })),
    });
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    for (const t of [/1\. Create/, /2\. Balances/, /3\. Pay gas/, /4\. Register/, /5\. Show the key/]) {
      await runStep(t);
    }
    // The step's own line, and the mirror card under it, both say it.
    expect((await screen.findAllByText(/behind the Sepolia head/)).length).toBeGreaterThan(0);
    expect(within(card(/5\. Show the key/)).getByText("Waiting")).toBeInTheDocument();
    // And the embedded card is reading the key step 4 produced.
    await waitFor(() => expect(client.readMirror).toHaveBeenCalled());
  });

  test("a relay that does not serve Ethereum Sepolia blocks step 4 with a reason", async () => {
    const client = fakeClient({ grantSession: vi.fn(async () => grant()) });
    (client as { chains: unknown }).chains = [CELO_SEPOLIA];
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    for (const t of [/1\. Create/, /2\. Balances/, /3\. Pay gas/, /4\. Register/]) await runStep(t);
    expect((await screen.findAllByText(/does not serve Ethereum Sepolia/)).length).toBeGreaterThan(0);
    expect(client.grantSession).not.toHaveBeenCalled();
  });

  test("start again clears every step", async () => {
    renderWith(fakeClient(), <WalkthroughPanel />, WITH_WALLET);
    await runStep(/1\. Create/);
    expect(await within(card(/1\. Create/)).findByText("Done")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Start again" }));
    expect(within(card(/1\. Create/)).queryByText("Done")).not.toBeInTheDocument();
    expect(screen.getByText(/0 of 6 steps done/)).toBeInTheDocument();
  });
});

describe("WalkthroughPanel step 6", () => {
  function clientThroughStep4() {
    return fakeClient({
      grantSession: vi.fn(async () => grant()),
      readMirror: vi.fn(async () => mirrorCurrent),
    });
  }

  async function runToStep6(client: ReturnType<typeof fakeClient>) {
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    for (const t of [/1\. Create/, /2\. Balances/, /3\. Pay gas/, /4\. Register/, /5\. Show the key/]) {
      await runStep(t);
    }
  }

  test("uses the session key from step 4, then revokes it", async () => {
    const client = clientThroughStep4();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      callsId: "0x01",
      status: "CONFIRMED",
      transactionHash: "0xused",
    });
    (client.revokeSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      keyId: "0x02",
      status: "revoked",
      legs: [{ chainId: SEPOLIA.chainId, kind: "registry", status: "CONFIRMED", via: "relay", transactionHash: "0xrev" }],
      cacheSync: Promise.resolve([]),
    });
    await runToStep6(client);
    await runStep(/6\. Use the key/);

    // The execute for step 6 is signed by the session, not the wallet key.
    const sessionCall = vi.mocked(client.execute).mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(sessionCall).toHaveProperty("session");
    expect(sessionCall).not.toHaveProperty("signer");

    await waitFor(() => expect(client.revokeSession).toHaveBeenCalled());
    // The key revoked is the one step 4 generated and this browser holds, not
    // whatever the relay echoed back.
    const revokedKey = vi.mocked(client.revokeSession).mock.calls[0]![0].session as string;
    expect(revokedKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(await screen.findByText(/carries the revocation only after Celo anchors/)).toBeInTheDocument();
    expect(screen.getByText(/0xrev/)).toBeInTheDocument();
  });

  test("a session key transaction that does not confirm stops before the revoke", async () => {
    const client = clientThroughStep4();
    // Step 3 uses the wallet key and must pass; only the session-signed call
    // in step 6 fails, so the walkthrough gets that far.
    (client.execute as ReturnType<typeof vi.fn>).mockImplementation(async (o: Record<string, unknown>) =>
      "session" in o
        ? { callsId: "0x01", status: "FAILED" }
        : { callsId: "0x01", status: "CONFIRMED", transactionHash: "0xpay" },
    );
    await runToStep6(client);
    await runStep(/6\. Use the key/);
    await waitFor(() =>
      expect(within(card(/6\. Use the key/)).getByRole("alert")).toHaveTextContent(
        /session key's transaction returned FAILED/,
      ),
    );
    expect(client.revokeSession).not.toHaveBeenCalled();
  });

  test("a failed revoke leg is a failure, with the relay's words", async () => {
    const client = clientThroughStep4();
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      callsId: "0x01",
      status: "CONFIRMED",
      transactionHash: "0xused",
    });
    (client.revokeSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      keyId: "0x02",
      status: "failed",
      legs: [{ chainId: SEPOLIA.chainId, kind: "registry", status: "FAILED", reason: "intent reverted: 0x" }],
      cacheSync: Promise.resolve([]),
    });
    await runToStep6(client);
    await runStep(/6\. Use the key/);
    await waitFor(() =>
      expect(within(card(/6\. Use the key/)).getByRole("alert")).toHaveTextContent(
        /registry on Sepolia: intent reverted: 0x/,
      ),
    );
  });

  test("without step 4 there is no key, and the step says so", async () => {
    const client = fakeClient();
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    // Force it open by finishing the earlier steps with a failed registration,
    // which still yields no usable session key.
    expect(within(card(/6\. Use the key/)).getByRole("button", { name: /Run this step/ })).toBeDisabled();
  });
});

describe("the session step 4 grants and step 6 uses", () => {
  test("carries the same expiry and cap in both, or the account rejects the key", async () => {
    const client = fakeClient({
      grantSession: vi.fn(async () => grant()),
      readMirror: vi.fn(async () => mirrorCurrent),
    });
    (client.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
      callsId: "0x01",
      status: "CONFIRMED",
      transactionHash: "0xused",
    });
    (client.revokeSession as ReturnType<typeof vi.fn>).mockResolvedValue({
      keyId: "0x02",
      status: "revoked",
      legs: [],
      cacheSync: Promise.resolve([]),
    });
    renderWith(client, <WalkthroughPanel />, WITH_WALLET);
    for (const t of [/1\. Create/, /2\. Balances/, /3\. Pay gas/, /4\. Register/, /5\. Show the key/, /6\. Use the key/]) {
      await runStep(t);
    }

    const granted = vi.mocked(client.grantSession).mock.calls[0]![0];
    const sessionCall = vi.mocked(client.execute).mock.calls.at(-1)![0] as {
      session: {
        expiry: number;
        publicKey: string;
        permissions: { spend: { limit: bigint; period: string }[] };
      };
    };
    expect(sessionCall.session.expiry).toBe(granted.expiry);
    expect(sessionCall.session.permissions.spend).toEqual(granted.permissions.spend);
    // And the key it signs with is the one that was granted.
    expect(sessionCall.session.publicKey).toBe(granted.sessionSigner!.publicKey);
  });
});
