/**
 * Passkey wallets on a cached-registry network, on the wire.
 *
 * A Celo Sepolia client provisions two chains: Celo Sepolia and the Sepolia
 * KeyStore chain behind it (`provisioningNetworks`). The wallet is one
 * address, so both chains must be upgraded over the *same* address, with the
 * passkey as the admin on each. The relay is played by a mocked fetch: these
 * assert the `wallet_prepareUpgradeAccount` requests the SDK sends.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { numberToHex, type Address } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { CELO_SEPOLIA, SEPOLIA } from "./config.js";
import { createWallet } from "./createWallet.js";
import { createHeadlessPasskey } from "./internal/passkey.js";
import { signerFromPrivateKey } from "./internal/signer.js";
import capabilities from "./internal/fixtures/celo-sepolia-capabilities.json" with { type: "json" };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Upgrade = { chainId: number; address: Address; authorizeKeys: any[] };

/** The `wallet_prepareUpgradeAccount` answer shape porto validates, echoing the request. */
function upgradeAnswer(p: any) {
  const chainId = numberToHex(Number(p.chainId));
  return {
    capabilities: { authorizeKeys: p.capabilities.authorizeKeys },
    chainId,
    context: {
      address: p.address,
      authorization: { address: capabilities["0xaa044c"].contracts.accountProxy.address, chainId, nonce: "0x0" },
      chainId,
      preCall: { eoa: p.address, executionData: "0x", nonce: "0x0", signature: "0x" },
    },
    digests: { auth: `0x${"11".repeat(32)}`, exec: `0x${"22".repeat(32)}` },
    typedData: { domain: {}, message: {}, primaryType: "PreCall", types: {} },
  };
}

/**
 * Plays the relay for the upgrade handshake on both chains. Celo Sepolia and
 * Sepolia share one relay URL, so the capabilities answer carries both.
 * Returns every prepareUpgradeAccount the SDK sent, in order.
 */
function mockUpgradeWire(): { upgrades: () => Upgrade[] } {
  const upgrades: Upgrade[] = [];
  const chain = capabilities["0xaa044c"];
  const both = {
    [numberToHex(CELO_SEPOLIA.chainId)]: chain,
    [numberToHex(SEPOLIA.chainId)]: chain,
  };
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reqs = Array.isArray(body) ? body : [body];
    const answers = reqs.map((req: { id: number; method: string; params: any }) => {
      const result = (() => {
        switch (req.method) {
          case "wallet_getCapabilities":
            return both;
          case "eth_chainId":
            return numberToHex(CELO_SEPOLIA.chainId);
          case "wallet_prepareUpgradeAccount": {
            const p = req.params[0];
            upgrades.push({
              chainId: Number(p.chainId),
              address: p.address,
              authorizeKeys: p.capabilities?.authorizeKeys ?? [],
            });
            return upgradeAnswer(p);
          }
          case "wallet_upgradeAccount":
            return undefined;
          default:
            throw new Error(`unexpected relay method ${req.method}`);
        }
      })();
      return { jsonrpc: "2.0", id: req.id, result };
    });
    return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return { upgrades: () => upgrades };
}

describe("createWallet with a passkey on a cached-registry network", () => {
  test("one address on Celo Sepolia and on the Sepolia registry chain behind it", async () => {
    const wire = mockUpgradeWire();
    const wallet = await createWallet({ signer: createHeadlessPasskey(), networks: [CELO_SEPOLIA] });

    const upgrades = wire.upgrades();
    expect(upgrades.length).toBe(2);
    // The bug this covers: a throwaway generated per chain gave the wallet a
    // different address on each, and createWallet refused with "signer
    // produced a different address on chain 11155111".
    expect(upgrades.map((u) => u.chainId)).toEqual([CELO_SEPOLIA.chainId, SEPOLIA.chainId]);
    expect(upgrades.map((u) => u.address)).toEqual([wallet.address, wallet.address]);
    expect(wallet.address).not.toBe("0x0000000000000000000000000000000000000000");
  });

  test("each wallet gets its own throwaway, so two passkeys are two wallets", async () => {
    const wire = mockUpgradeWire();
    const first = await createWallet({ signer: createHeadlessPasskey(), networks: [CELO_SEPOLIA] });
    const second = await createWallet({ signer: createHeadlessPasskey(), networks: [CELO_SEPOLIA] });
    expect(first.address).not.toBe(second.address);
    expect(wire.upgrades().map((u) => u.address)).toEqual([
      first.address,
      first.address,
      second.address,
      second.address,
    ]);
  });

  test("the passkey is the admin on both chains, not the throwaway", async () => {
    const wire = mockUpgradeWire();
    const passkey = createHeadlessPasskey();
    const wallet = await createWallet({ signer: passkey, networks: [CELO_SEPOLIA] });

    for (const upgrade of wire.upgrades()) {
      expect(upgrade.authorizeKeys.length).toBe(1);
      const key = upgrade.authorizeKeys[0];
      expect(String(key.type)).toBe("webauthnp256");
      expect(String(key.publicKey).toLowerCase()).toBe(String(passkey.publicKey).toLowerCase());
      expect(key.role).toBe("admin");
    }
    // The wallet address is the throwaway EOA's, which is not the passkey's
    // placeholder address and is not recoverable from the passkey's key.
    expect(wallet.address).not.toBe(passkey.address);
  });

  test("the same wallet works with several execution networks at once", async () => {
    const wire = mockUpgradeWire();
    const wallet = await createWallet({
      signer: createHeadlessPasskey(),
      networks: [CELO_SEPOLIA, SEPOLIA],
    });
    // Celo Sepolia, its registry chain, and Sepolia as an execution network:
    // three pushes, deduplicated to two chains.
    const upgrades = wire.upgrades();
    expect(upgrades.length).toBe(2);
    expect(new Set(upgrades.map((u) => u.address))).toEqual(new Set([wallet.address]));
  });

  test("a private-key signer still owns its own EOA as the wallet address", async () => {
    const wire = mockUpgradeWire();
    const pk = generatePrivateKey();
    const wallet = await createWallet({ signer: signerFromPrivateKey(pk), networks: [CELO_SEPOLIA] });

    expect(wallet.address).toBe(privateKeyToAccount(pk).address);
    for (const upgrade of wire.upgrades()) {
      expect(upgrade.address).toBe(wallet.address);
      expect(String(upgrade.authorizeKeys[0].type)).toBe("secp256k1");
    }
  });
});
