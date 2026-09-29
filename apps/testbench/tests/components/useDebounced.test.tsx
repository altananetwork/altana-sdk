import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useDebounced } from "../../src/lib/useDebounced";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useDebounced", () => {
  test("holds the first value until the delay passes", () => {
    const { result } = renderHook(() => useDebounced("a", 400));
    expect(result.current).toBe("a");
  });

  test("a value that keeps changing never settles on an intermediate one", () => {
    // This is the mirror form: a public key typed a character at a time passes
    // through a 66 character prefix, which is a valid but entirely different
    // key id. Reading that would show a wrong answer on the way to the right one.
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 400), {
      initialProps: { v: "0x" },
    });
    for (const v of ["0x0", "0x04", "0x04ab"]) {
      rerender({ v });
      act(() => void vi.advanceTimersByTime(100));
      expect(result.current).toBe("0x");
    }
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current).toBe("0x04ab");
  });

  test("it settles once typing stops", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 400), {
      initialProps: { v: "a" },
    });
    rerender({ v: "b" });
    expect(result.current).toBe("a");
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current).toBe("b");
  });
});
