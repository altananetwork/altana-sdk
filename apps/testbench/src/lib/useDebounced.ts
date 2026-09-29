import { useEffect, useState } from "react";

/**
 * The value, once it has stopped changing for `delayMs`.
 *
 * Both the mirror form and the x402 seller field drive a network call from
 * what is typed in them. Without this, pasting a 132 character public key
 * fires a chain read at character 66, where the value is a different key
 * entirely and reads as never registered: a wrong answer, shown for a moment,
 * on the one card whose whole job is to be trusted.
 */
export function useDebounced<T>(value: T, delayMs = 400): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return settled;
}
