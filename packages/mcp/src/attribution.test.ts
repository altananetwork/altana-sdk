import { describe, expect, test } from "bun:test";
import { attributionFromEnv, MCP_CODE } from "./attribution.js";

describe("the attribution tag this server sends", () => {
  test("is the server's own code when nothing is set", () => {
    expect(attributionFromEnv({})).toEqual({ options: { appCode: [MCP_CODE] } });
    expect(attributionFromEnv({ ALTANA_APP_CODE: "  " })).toEqual({ options: { appCode: [MCP_CODE] } });
  });

  test("ALTANA_APP_CODE adds the builder's own code, or several", () => {
    expect(attributionFromEnv({ ALTANA_APP_CODE: "my_agent" }).options).toEqual({ appCode: [MCP_CODE, "my_agent"] });
    expect(attributionFromEnv({ ALTANA_APP_CODE: "my_agent, celo_b7k3p9da" }).options).toEqual({
      appCode: [MCP_CODE, "my_agent", "celo_b7k3p9da"],
    });
  });

  test("a code that cannot be used is left out and reported, not thrown", () => {
    expect(attributionFromEnv({ ALTANA_APP_CODE: "My Agent" })).toEqual({ options: { appCode: [MCP_CODE] }, rejected: "My Agent" });
  });

  test("ALTANA_ATTRIBUTION=off, false, 0 and no send no tag", () => {
    for (const value of ["off", "OFF", " false ", "0", "no"]) {
      expect(attributionFromEnv({ ALTANA_ATTRIBUTION: value, ALTANA_APP_CODE: "my_agent" })).toEqual({ options: { attribution: false } });
    }
  });

  test("anything else leaves it on", () => {
    for (const value of [undefined, "", "on", "true", "1"]) {
      expect(attributionFromEnv({ ALTANA_ATTRIBUTION: value }).options).toEqual({ appCode: [MCP_CODE] });
    }
  });
});
