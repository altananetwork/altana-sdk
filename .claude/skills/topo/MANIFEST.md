# Authoring the Topo manifest — complete reference

`system.topo` is a **hand-authored manifest**. You write the whole system design in
it — the systems, the arrows between them, and **which code each system owns** — and
Topo verifies it against the actual code. Topo never generates or edits this file.

Two things live in the manifest:

1. **The design** — worlds, systems, and the connections between them (the diagram).
2. **The code binding** — each system declares the files it owns with `code "glob"`.

Topo hashes each owned region into `system.topo.lock` (committed). `topo check` then
fails if any code is unowned, if an owned region changed since it was approved, or if
a glob points at nothing. There are **no comments in your source code** — everything
is in this one file.

## Grammar

```
world <Name> { … }                     // the root — exactly one
system   <Name> { … }                  // an open container (has children)
activity <Name> { … }                  // a leaf that does something
storage  <Name> { … }                  // a leaf that holds things
gateway  <Name> { … }                  // an external dependency you don't own
thing <Name> { field: Type … }         // a data shape — declare one per Thing used

  code "<glob>"                        // source files this system owns (see below)
  <A> --( <Thing> )--> <B>             // an authored connection (the arrows)
  in <Thing> | out <Thing> | holds <Thing>   // the box's boundary — its interface
```

- Names and Thing names are single identifiers (`[A-Za-z_]\w*`, no spaces).
- **You draw the arrows.** Write `A --( Thing )--> B` connections by hand, in the
  **nearest common parent** of the two endpoints. Topo does **not** derive
  connections — the picture is exactly what you author, so design it deliberately.
- **Boundaries are the interface, not decoration.** Every leaf declares them
  (`activity` → `in`/`out`, `storage` → `holds`, `gateway` → what crosses to it),
  and a container `system` declares every Thing that crosses its edge. This is what
  makes the map readable at every zoom level: when an arrow runs from deep inside
  one box to deep inside another, each edge it crosses should declare the Thing.
  `topo check` warns (`design: boundary gap`) at minimum when a Thing flows through
  a box that never declares it anywhere — but aim for the full contract, not the
  minimum.

## Things — the data shapes are half the map

Every Thing that appears on a boundary or an arrow gets a `thing` declaration with
its **complete shape**, at file scope (above the world). The boxes say who does the
work; the Things say what the work *is* — a map whose data is unshaped is only half
designed.

```
thing Payment { amount: money  method: text  paid_at: time  order_id: id }
```

- **Complete means complete.** Declare every field the data actually carries. If the
  code has a contract for it (a TS interface, a schema, a table), mirror it fully —
  don't summarize it down to a few representative fields.
- **Types must be honest.** `text` `int` `number` `money` `bool` `id` `time`, and
  `[T]` for a list (e.g. `[text]`, `[Listing]`); fields may reference other Things
  by name. Identifiers are `id` (not text), timestamps are `time` (not text),
  prices/amounts are `money` (not int), flags are `bool`. Defaulting everything to
  `text` is a design smell the check will call out.
- `topo check` warns on a Thing used with no declaration (`design: undeclared
  thing`), a declared shape with no fields (`design: empty thing`), and fields whose
  names imply a richer type than declared (`design: field type` — e.g.
  `config_id: text`, `price_amount: int`, `scraped_at: text`).

## `code` — binding systems to files

Each system claims the source files it owns with one or more `code` lines:

```
system Payments {
  code "src/payments/**"
  code "src/api/charges.ts"
  activity Charges { }
  storage Ledger { }
  Charges --( Charge )--> Ledger
}
```

- `code` may appear on **any** node — `system`, `activity`, or `storage`. Leaves are
  matched by the same rules below.
- Globs are standard (`**`, `*`, `?`, `{a,b}`), matched from the repo root, honoring
  `.gitignore` and the config `ignore` list. **Paths with spaces work as-is inside
  the quotes** — `code "Collection layer/**"` — no escaping needed.
- **Most-specific wins, and nesting breaks ties.** When globs overlap, the file goes
  to the system whose glob has the deeper static base (then the longer glob). So a
  parent can claim `code "src/**"` and a child refine it with `code "src/payments/**"`.
  If a parent **and its own child** point at the *same* glob, the **child wins** (it's
  nested inside) — you don't have to strip the parent's line. Only two *unrelated*
  systems claiming a file equally is an `ambiguous-ownership` error; make one glob
  more specific.
- A `gateway` (external) or a pure grouping `system` may own no code — that's fine, as
  long as every *file* ends up owned by some system.

## Coverage — every source file must be owned

By default (`policy.coverage: "strict"`) **every file in the coverage universe must be
owned by a system**, or `topo check` fails with `uncovered-code`. The universe is the
files matching `include` minus `ignore` in `topo.config.json` — scoped to source code,
and meant to be tuned:

- Own a file by extending some system's `code` glob to cover it.
- Or exclude non-system files (generated code, vendored deps, fixtures) by adding to
  `ignore` or narrowing `include`.

Coverage policy (`topo.config.json` → `policy.coverage`): `strict` (default, whole
repo) · `mapped` (only files under an already-owned directory must be owned) · `off`.

## The digest lock and approval

`topo approve` writes `system.topo.lock`: for each system, the globs, every owned
file's `sha256`, and a rolled-up region digest, plus a hash of the manifest itself.
This is the **last approved (map, code) snapshot** — commit it.

`topo check` recomputes and compares:

| Failure | Meaning | Fix |
|---|---|---|
| `uncovered-code` | a file no system owns | add it to a system's `code`, or `ignore` it |
| `region-changed` | an owned region's code changed since approval | review it, update the diagram if the structure changed, then `topo approve` |
| `dangling-code` | a glob matches no source file | fix or remove the glob |
| `ambiguous-ownership` | two equally-specific globs claim a file | make one more specific |
| `manifest-unapproved` | `system.topo` changed (or was never approved) | `topo approve` |

`topo check` also emits **design warnings** (non-blocking; `--strict` promotes them).
They measure whether the map reads as a real diagram, not a file index — fix them:

| Warning | Meaning | Fix |
|---|---|---|
| `design: bare leaf` | an activity/storage/gateway with no `in`/`out`/`holds` | declare its boundary — what does it take in, produce, or hold? |
| `design: disconnected` | a box wired to nothing (no boundary, no arrows, whole subtree) | wire it in, or fold its code into the system it serves — don't keep a box just to own files |
| `design: boundary gap` | an arrow crosses a box's edge the box doesn't declare | add `in`/`out` for that Thing on each crossed edge |
| `design: unknown endpoint` | an arrow names a system that isn't declared | declare the box or fix the name |

`topo approve` (no args) re-locks the whole repo. `topo approve <System…>` re-locks
just those regions (keeping the rest of the lock) — useful to acknowledge a code
change in one area without re-blessing everything.

Under `policy.approval: "human"`, `topo approve` requires `--confirm` (or a TTY) and
is a person's job; under the default `"agent"`, the AI runs it in its loop.
