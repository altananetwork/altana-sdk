import { test, expect } from "bun:test";
import { VERSION } from "./version.js";
import pkg from "../package.json" with { type: "json" };

test("advertises the published package version", () => {
  expect(VERSION).toBe(pkg.version);
});

// This package shipped 0.1.0 over the wire against a published 0.2.0. The
// literal is gone now; this keeps it gone.
test("server construction has no hardcoded version literal", async () => {
  const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();
  const constructorBlock = source.slice(
    source.indexOf("new McpServer("),
    source.indexOf("new McpServer(") + 400,
  );
  expect(constructorBlock).toContain("version: VERSION");
  expect(constructorBlock).not.toMatch(/version:\s*["'`]\d+\.\d+\.\d+/);
});
