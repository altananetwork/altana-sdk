import { describe, expect, test } from "bun:test";
import { sdkBuild } from "./buildInfo.js";

describe("the build stamp", () => {
  test("is shaped so a run can report what it ran", () => {
    expect(typeof sdkBuild.commit).toBe("string");
    expect(typeof sdkBuild.dirty).toBe("boolean");
    expect(typeof sdkBuild.builtAt).toBe("string");
    // Asserting the stamp is SET would fail in a tarball or an export, where
    // there is no repository to read and "unknown" is the honest answer.
    expect(sdkBuild.describe.length).toBeGreaterThan(0);
  });

  test("a stamped build describes itself as a short commit, dirty marked", () => {
    if (!sdkBuild.commit) {
      expect(sdkBuild.describe).toBe("unknown");
      return;
    }
    expect(sdkBuild.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(sdkBuild.describe.startsWith(sdkBuild.commit.slice(0, 7))).toBe(true);
    // The dirty flag has to reach `describe`, because that is the string a run
    // log carries and a clean-looking log of a dirty build is the failure.
    expect(sdkBuild.describe.endsWith("+dirty")).toBe(sdkBuild.dirty);
  });
});
