#!/usr/bin/env python3
"""
Turn a diagnose-first-bundle.ts log into rates, so the conclusion is computed
rather than eyeballed.

    python3 analyze-first-bundle.py <log>

The distinction that matters is "first bundle" versus "later bundle", meaning
whether the wallet already had delegation code, not which attempt it was. A
failed first attempt leaves the second attempt a first bundle too, so counting
by attempt number would answer a different question from the one being asked.
"""
import re, sys, collections

log = open(sys.argv[1]).read().splitlines()
rows = []
for line in log:
    m = re.match(r"\s*(\d+)/(\d+) (0x[0-9a-fA-F]{40})\s+a1 (ok|FAIL)\s*\((first|delegated)\s*\)\s+a2 (ok|FAIL)\s*\((first|delegated)\s*\)", line)
    if m:
        i, _n, w, s1, d1, s2, d2 = m.groups()
        rows.append({"i": int(i), "wallet": w,
                     "a1": (s1 == "ok", d1), "a2": (s2 == "ok", d2)})

attempts = []
for r in rows:
    for k in ("a1", "a2"):
        ok, kind = r[k]
        attempts.append({"wallet": r["wallet"], "attempt": k, "ok": ok, "kind": kind, "i": r["i"]})

def rate(sel):
    s = [a for a in attempts if sel(a)]
    bad = [a for a in s if not a["ok"]]
    pc = f"{len(bad)/len(s)*100:.0f}%" if s else "n/a"
    return len(s), len(bad), pc

print(f"wallets measured: {len(rows)}   attempts: {len(attempts)}")
print()
print("                                  n  failed  rate")
for label, sel in [
    ("all attempts",              lambda a: True),
    ("FIRST bundle (not yet delegated)", lambda a: a["kind"] == "first"),
    ("LATER bundle (already delegated)", lambda a: a["kind"] == "delegated"),
    ("attempt 1 of a wallet",     lambda a: a["attempt"] == "a1"),
    ("attempt 2 of a wallet",     lambda a: a["attempt"] == "a2"),
]:
    n, bad, pc = rate(sel)
    print(f"  {label:<33} {n:>2}  {bad:>5}  {pc:>5}")

print()
first_failed_then_ok = [r for r in rows if not r["a1"][0] and r["a2"][0]]
both_failed = [r for r in rows if not r["a1"][0] and not r["a2"][0]]
print(f"attempt 1 failed, attempt 2 landed:  {len(first_failed_then_ok)}")
print(f"both attempts failed:                {len(both_failed)}")
print()
print("order of outcomes, to show whether failures cluster in time:")
line = "".join(("." if r["a1"][0] else "X") + ("." if r["a2"][0] else "X") for r in rows)
print(f"  {line}    ( . = landed, X = failed, two per wallet in order )")
runs = [(c, len(list(g))) for c, g in __import__("itertools").groupby(line)]
longest_x = max((n for c, n in runs if c == "X"), default=0)
print(f"  longest unbroken run of failures: {longest_x} consecutive attempts")
