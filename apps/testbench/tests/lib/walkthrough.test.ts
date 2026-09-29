import { describe, expect, test } from "vitest";
import {
  canRun,
  currentStep,
  dataOf,
  emptyWalkthrough,
  progress,
  setStep,
  STEP_BLURBS,
  STEP_ORDER,
  STEP_TITLES,
} from "../../src/lib/walkthrough";

const PUBLIC_KEY = "0x04ab" as const;
const KEY_ID = "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

describe("walkthrough", () => {
  test("every step has a title and a blurb, and they are the spine's six", () => {
    expect(STEP_ORDER).toHaveLength(6);
    for (const id of STEP_ORDER) {
      expect(STEP_TITLES[id].length).toBeGreaterThan(10);
      expect(STEP_BLURBS[id].length).toBeGreaterThan(30);
    }
  });

  test("a fresh walkthrough can only run its first step", () => {
    const s = emptyWalkthrough();
    expect(canRun(s, "create")).toBe(true);
    expect(canRun(s, "pay")).toBe(false);
    expect(currentStep(s)).toBe("create");
  });

  test("a step opens only when every step before it is done", () => {
    let s = emptyWalkthrough();
    s = setStep(s, "create", { status: "done" });
    expect(canRun(s, "balances")).toBe(true);
    expect(canRun(s, "pay")).toBe(false);
    s = setStep(s, "balances", { status: "done" });
    expect(canRun(s, "pay")).toBe(true);
  });

  test("a failed step stops the ones after it", () => {
    let s = emptyWalkthrough();
    s = setStep(s, "create", { status: "done" });
    s = setStep(s, "balances", { status: "done" });
    s = setStep(s, "pay", { status: "failed", error: "intent reverted: 0x" });
    expect(canRun(s, "register")).toBe(false);
    expect(progress(s)).toEqual({ done: 2, total: 6, failed: true });
  });

  test("a waiting step is still the current one: the wait is the step", () => {
    let s = emptyWalkthrough();
    for (const id of ["create", "balances", "pay", "register"] as const) s = setStep(s, id, { status: "done" });
    s = setStep(s, "mirror", { status: "waiting", detail: "Celo anchors block 11807636" });
    expect(currentStep(s)).toBe("mirror");
    expect(canRun(s, "use-and-revoke")).toBe(false);
    expect(progress(s).failed).toBe(false);
  });

  test("a running step cannot be started again", () => {
    const s = setStep(emptyWalkthrough(), "create", { status: "running" });
    expect(canRun(s, "create")).toBe(false);
  });

  test("a blocked step is not done, so it does not open the next one", () => {
    const s = setStep(emptyWalkthrough(), "create", { status: "blocked", detail: "no wallet" });
    expect(canRun(s, "balances")).toBe(false);
    expect(progress(s).done).toBe(0);
  });

  test("the data a step produced is readable by the ones after it", () => {
    let s = emptyWalkthrough();
    s = setStep(s, "create", { status: "done", data: { walletAddress: "0xabc" } });
    s = setStep(s, "register", {
      status: "done",
      data: { sessionPublicKey: PUBLIC_KEY, sessionKeyId: KEY_ID, registryBlock: 11807636n },
    });
    expect(dataOf(s)).toEqual({
      walletAddress: "0xabc",
      sessionPublicKey: PUBLIC_KEY,
      sessionKeyId: KEY_ID,
      registryBlock: 11807636n,
    });
  });

  test("data of the wrong shape is ignored rather than passed on", () => {
    const s = setStep(emptyWalkthrough(), "register", { status: "done", data: { sessionKeyId: 42 } });
    expect(dataOf(s).sessionKeyId).toBeUndefined();
  });

  test("all six done reports six of six and no failure", () => {
    let s = emptyWalkthrough();
    for (const id of STEP_ORDER) s = setStep(s, id, { status: "done" });
    expect(progress(s)).toEqual({ done: 6, total: 6, failed: false });
    expect(currentStep(s)).toBeUndefined();
  });
});
