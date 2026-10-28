/**
 * The redaction, and the failure that explains itself.
 *
 * The redaction is the part where a bug is expensive: anvil quotes the fork
 * URL back in its errors, the URL carries an API key, and a key printed into a
 * CI log cannot be taken back.
 */
import { describe, expect, test } from "bun:test";
import { startAnvil, waitForAnvil, withoutUrls } from "./anvil.js";

/**
 * CI's unit-test job has no foundry — only the fork job installs it — so the
 * one case that needs a real anvil says it was skipped rather than failing on
 * a missing binary. Every other case here is pure and runs everywhere.
 */
const anvilOnPath = !!Bun.which("anvil");
if (!anvilOnPath) console.log("anvil is not on PATH: skipping the one case that starts a real one");

describe("withoutUrls", () => {
  test("takes out the URL anvil quotes back, key and all", () => {
    const said = "- Error #0: error sending request for url (https://base-mainnet.nodereal.io/v1/0ab1cd2ef3)";
    expect(withoutUrls(said)).toBe("- Error #0: error sending request for url (<url>)");
    expect(withoutUrls(said)).not.toContain("0ab1cd2ef3");
  });

  test("keeps the part that says what went wrong", () => {
    const said = "Error: failed to get fork block number\nContext:\n- HTTP error 404 with body: invalid method";
    expect(withoutUrls(said)).toBe(said);
  });

  test("takes out every URL, whatever the scheme, and leaves the rest of the line", () => {
    expect(withoutUrls("ws://host/key1 and http://h/k2, then https://h/k3.")).toBe("<url> and <url>, then <url>.");
  });

  test("a localhost URL goes too: no URL is worth the risk of mistaking one", () => {
    expect(withoutUrls("probing http://127.0.0.1:8545")).toBe("probing <url>");
  });
});

describe("waitForAnvil", () => {
  test("a probe that answers at once returns, and says nothing", async () => {
    const fake = { kill: () => {}, url: "http://127.0.0.1:1", port: 1, said: () => "", exitCode: () => undefined };
    await expect(waitForAnvil(fake, async () => 1n)).resolves.toBeUndefined();
  });

  test("an exited anvil fails immediately, carrying its words", async () => {
    const fake = {
      kill: () => {},
      url: "http://127.0.0.1:1",
      port: 1,
      said: () => "Error: failed to get fork block number",
      exitCode: () => 1,
    };
    const err = await waitForAnvil(fake, async () => {
      throw new Error("connection refused");
    }).catch((e: Error) => e);
    expect(err.message).toContain("it exited with code 1");
    expect(err.message).toContain("failed to get fork block number");
  });

  test("a running anvil that never answers says so, with the port and the wait", async () => {
    const fake = { kill: () => {}, url: "http://127.0.0.1:7", port: 7, said: () => "", exitCode: () => undefined };
    const err = await waitForAnvil(
      fake,
      async () => {
        throw new Error("nope");
      },
      { attempts: 2, everyMs: 1 },
    ).catch((e: Error) => e);
    expect(err.message).toContain("never answered on port 7");
    expect(err.message).toContain("anvil said nothing on stderr");
  });

  /**
   * The whole point, end to end: a fork URL that cannot work, and the reason
   * in the error rather than thirty seconds of silence. No network — the URL
   * resolves to nothing, which is a failure anvil reports in its first second.
   */
  test.skipIf(!anvilOnPath)("a real anvil told to fork nothing explains itself", async () => {
    const anvil = startAnvil("http://127.0.0.1:1/unreachable-fork-url", 8599);
    try {
      const err = await waitForAnvil(anvil, undefined, { attempts: 40, everyMs: 250 }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("anvil said:");
      expect(err.message).toContain("fork block number");
      expect(err.message).not.toContain("unreachable-fork-url");
    } finally {
      anvil.kill();
    }
  }, 20_000);
});
