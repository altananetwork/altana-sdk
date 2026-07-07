---
name: topo
description: Keep the Topo system map (system.topo) accurate. Use after any change that adds, removes, renames, or rewires a system — or moves the code a system owns — and whenever `topo check` is red. The check is a hard blocker; do not finish until it passes. Never add comments to source code.
---

# Keep the Topo map accurate

This repo's architecture is a **hand-authored map**, `system.topo` — a Topos "worlds
within worlds" description: every box is a system, every arrow carries a named Thing.
Each system also declares which code it owns (`code "glob"`); Topo hashes that code
into `system.topo.lock` and `topo check` fails on drift. The check is a HARD BLOCKER.

**Never write `//@topo` comments or any Topo markers in source code.** Everything
lives in `system.topo`. Full grammar reference: `MANIFEST.md` next to this file.

## The prime directive: design first, bind code second

The map is a **design**, not a file index. Author it in two distinct passes:

**Pass 1 — design the world (ignore files entirely).** Write the map you would draw
on a whiteboard for a new engineer: the systems, what flows between them, what each
box takes in and puts out — and **declare every Thing with its complete shape**
(all its real fields, honestly typed — mirror the code's contract if one exists).
Start with the data: naming the Things and their shapes first makes the boxes and
arrows almost draw themselves. Judge the result purely as a diagram: does every
level tell a complete story?

**Pass 2 — bind the code.** Only then add `code "glob"` lines so every source file is
owned. **Binding must never reshape the design.** If files don't fit any box, they
belong to the nearest parent system's glob — do NOT invent a box to hold leftovers.

## Design rules (the house style — follow all of these)

1. **Map concepts, not directories.** A box exists because the system *has* that part,
   not because a folder exists. Never mirror the file tree (`api/` folders ≠ one
   activity per route file). Two directories that implement one concept are ONE box.
2. **Every level must read complete on its own.** A reader opening any box sees a
   full picture: 3–9 labeled boxes, what each takes in / puts out, and arrows showing
   who feeds whom. If a level only makes sense by peeking inside its children, the
   boundaries are missing.
3. **Every box declares its boundary.** Leaves always: an `activity` has `in`/`out`,
   a `storage` has `holds`, a `gateway` declares what crosses to it. A container
   `system` declares every Thing that crosses its edge. A box with no boundary is a
   dead box on the diagram.
4. **Arrows carry Things and are written in the nearest common parent.** When an
   arrow crosses a box's edge, that box must declare the Thing (`in`/`out`). That's
   what lets the same flow render truthfully at every zoom level.
5. **Every Thing gets its complete shape.** Declare `thing X { field: type }` for
   every Thing the map uses, with **every field the data actually carries** — if the
   code has a contract for it (interface, schema, table), mirror it fully. Types
   must be honest: `id` for identifiers, `time` for timestamps, `money` for
   prices/amounts, `bool` for flags, `[T]` for lists — not everything as `text`.
   A used-but-undeclared Thing, an empty `thing X { }`, or a lazily-typed field is
   an unfinished design.
6. **No junk drawers.** Never create a system named Operations/Utils/Misc/Shared to
   warehouse scripts, tests, types, or config. Bind those files to the system they
   serve (tests of the validator belong to the validator) or to the parent container.
7. **Right-size every level.** More than ~9 siblings → group them into a subsystem.
   A container with one child → dissolve it. Depth is earned by real structure.
8. **Name boxes by role, Things by payload.** `Validation`, not `SrcValidation`;
   `Listing`, not `Data`. Single identifiers, PascalCase.

## Worked exemplar — the shape to imitate

```
thing Order   { items: [text]  table: int }
thing Cup     { drink: text  size: text }
thing Beans   { origin: text  kg: number }
thing Payment { amount: money  method: text }

world CoffeeBar {

  gateway Customer { out Order  in Cup  out Payment }
  gateway Roaster  { in Payment  out Beans }

  system FrontOfHouse {
    code "src/front/**"
    in Order   out Order     // takes the order, passes it back of house
    in Cup     out Cup       // receives the drink, serves it
    in Payment out Payment   // takes payment, forwards it to the roaster

    activity TakeOrder { code "src/front/register.ts"  in Order  out Order }
    activity Serve     { code "src/front/serve.ts"     in Cup    out Cup }
  }

  system BackOfHouse {
    code "src/back/**"
    in Order  in Beans  out Cup

    activity Brew  { code "src/back/brew.ts"  in Order  in Beans  out Cup }
    storage  Shelf { code "src/back/shelf.ts" holds Beans }

    Shelf --( Beans )--> Brew
  }

  Customer     --( Order )-->   TakeOrder
  TakeOrder    --( Order )-->   Brew
  Brew         --( Cup )-->     Serve
  Serve        --( Cup )-->     Customer
  Customer     --( Payment )--> FrontOfHouse
  FrontOfHouse --( Payment )--> Roaster
  Roaster      --( Beans )-->   Shelf
}
```

Study why this reads well: the world level alone tells the whole story (order in, cup
out, payment funds beans). Arrows may run to nested leaves (`Customer → TakeOrder`),
and every edge they cross declares the Thing — that's why FrontOfHouse's boundary
lists `in Order out Order`: the order enters it and leaves it. Every leaf has a
boundary. Code binding follows the design, not the other way around. This map
produces zero design warnings — yours should too.

## The loop (maintenance — do this after every structural change)

1. Make your code change.
2. Update `system.topo` to match reality: boxes, boundaries, arrows, and the
   `code "glob"` lines, applying the design rules above.
3. Run **`topo check`** and resolve what it reports:
   - **Failures** (block): `uncovered-code` (extend a glob or `ignore` non-code),
     `region-changed` (confirm the diagram still reflects the code), `dangling-code`,
     `ambiguous-ownership` (two *unrelated* systems claim a file — a parent + its own
     child sharing a glob is fine, the child wins), `manifest-unapproved`.
   - **`design:` warnings** (don't block, but treat them as review feedback):
     `bare-leaf`, `disconnected`, `boundary-gap`, `unknown endpoint`,
     `undeclared thing`, `empty thing`, `field type`. Fix them — they are
     precisely the difference between a file index and a real map.
4. Run **`topo approve`** — locks the approved snapshot (`system.topo.lock`).
5. Commit `system.topo`, `system.topo.lock`, and the code together.

> If `topo.config.json` sets `policy.approval` to `"human"`, do NOT run `topo approve`
> yourself — a person approves (via `topo approve --confirm` or the viewer).

## First run — authoring from scratch

1. Survey the codebase top-down (READMEs, entry points, deploy targets) until you can
   name the 3–9 top-level systems and the external gateways.
2. **Pass 1**: write the full design — every `thing` with its fields, gateways,
   systems with boundaries, arrows — judged only as a diagram (rules above,
   exemplar as the bar).
3. **Pass 2**: bind code with `code` globs until `topo check` shows full coverage.
   Leftover files go to parent globs, never to new boxes.
4. `topo check` → fix failures AND design warnings → `topo approve` → green.

## Hard rules

- NEVER write `//@topo` markers or any Topo comment in source files.
- NEVER finish a task with `topo check` red.
- NEVER invent a system just to own files (no junk drawers).
- NEVER hand-edit `system.topo.lock` — it's produced by `topo approve`.
- Leave zero `design:` warnings you can't justify out loud.
