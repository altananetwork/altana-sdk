import { test, expect } from "bun:test";
import { VERSION } from "./version.js";
import pkg from "../package.json" with { type: "json" };

test("advertises the published package version", () => {
  expect(VERSION).toBe(pkg.version);
});

// The bug this guards against: a version repeated by hand in the server
// constructor drifts at the next release, and an AI host asking what it is
// talking to gets a stale answer with nothing to signal it. Keep the literal
// out of the source so there is nothing to forget to update.
test("server construction has no hardcoded version literal", async () => {
  const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const constructorBlock = source.slice(
    source.indexOf("new McpServer("),
    source.indexOf("new McpServer(") + 400,
  );
  expect(constructorBlock).toContain("version: VERSION");
  expect(constructorBlock).not.toMatch(/version:\s*["'`]\d+\.\d+\.\d+/);
});
