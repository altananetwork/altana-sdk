import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearLink, linkPath, LinkError, readLink, writeLink } from "./link.js";

let home: string;
const realHome = process.env.ALTANA_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "altana-link-"));
  process.env.ALTANA_HOME = home;
});

afterEach(async () => {
  if (realHome === undefined) delete process.env.ALTANA_HOME;
  else process.env.ALTANA_HOME = realHome;
  await rm(home, { recursive: true, force: true });
});

const ADDRESS = "0x1111111111111111111111111111111111111111";

describe("writeLink", () => {
  test("writes the contract's shape at 0600", async () => {
    const link = await writeLink({ address: ADDRESS, chainId: 97 });
    expect(link).toMatchObject({ v: 1, address: ADDRESS, chainId: 97 });
    expect(Date.parse(link.linkedAt)).not.toBeNaN();
    expect((await stat(linkPath())).mode & 0o777).toBe(0o600);
  });

  test("leaves no temporary file, because the MCP reads this on every call", async () => {
    await writeLink({ address: ADDRESS, chainId: 97 });
    expect((await readdir(home)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("relinking replaces the address", async () => {
    await writeLink({ address: ADDRESS, chainId: 97 });
    const second = "0x2222222222222222222222222222222222222222";
    await writeLink({ address: second, chainId: 97 });
    expect((await readLink())?.address).toBe(second);
  });

  test("accepts an address with surrounding whitespace, which is how one arrives pasted", async () => {
    await writeLink({ address: `  ${ADDRESS}  `, chainId: 97 });
    expect((await readLink())?.address).toBe(ADDRESS);
  });

  test("refuses a bad address and writes nothing", async () => {
    await expect(writeLink({ address: "0xnope", chainId: 97 })).rejects.toThrow(LinkError);
    expect(await readLink()).toBeUndefined();
  });

  test("refuses a bad chain and writes nothing", async () => {
    await expect(writeLink({ address: ADDRESS, chainId: 0 })).rejects.toThrow(LinkError);
    await expect(writeLink({ address: ADDRESS, chainId: 1.5 })).rejects.toThrow(LinkError);
    expect(await readLink()).toBeUndefined();
  });
});

describe("readLink", () => {
  test("no file means no link", async () => {
    expect(await readLink()).toBeUndefined();
  });

  test("a malformed file reads as no link rather than throwing", async () => {
    // The answer for no link is "open the extension and click Connect", which
    // is also the right fix for a corrupt file, so this does not need to be an
    // error the agent has to explain.
    await writeFile(linkPath(), "{ not json");
    expect(await readLink()).toBeUndefined();
  });

  test("a file missing its address or chain reads as no link", async () => {
    await writeFile(linkPath(), JSON.stringify({ v: 1, chainId: 97 }));
    expect(await readLink()).toBeUndefined();
    await writeFile(linkPath(), JSON.stringify({ v: 1, address: ADDRESS }));
    expect(await readLink()).toBeUndefined();
  });
});

describe("clearLink", () => {
  test("removes the link and is idempotent", async () => {
    await writeLink({ address: ADDRESS, chainId: 97 });
    await clearLink();
    expect(await readLink()).toBeUndefined();
    await clearLink();
  });
});
