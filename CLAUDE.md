# Sdk

## Topo system map

This repo keeps a hand-authored Topo system map, `system.topo`: the systems, the
arrows between them, and — via `code "glob"` lines — which code each system owns.
Topo hashes the owned code into `system.topo.lock` and `topo check` blocks on drift.
**Structure lives only in `system.topo`; never add `//@topo` comments to source code.**

**Binding rule:** after any change that adds, removes, renames, or rewires a
system / activity / storage / gateway — or moves the code a system owns — you MUST:

1. Update `system.topo` to match reality: the systems, the `--( )-->` arrows, and
   each system's `code "glob"` so every source file stays owned. Design first, bind
   code second — the map is a diagram of concepts, never a mirror of the file tree.
2. Run `topo check` — a **hard blocker** (exit 0 = green). Fix every entry it lists,
   and treat `design:` warnings as review feedback to resolve, not noise.
3. Run `topo approve` — records the approved snapshot (`system.topo.lock`).
4. Commit `system.topo`, `system.topo.lock`, and the code together.

If `topo.config.json` sets `policy.approval` to `"human"`, leave `topo approve` to a
person (they run `topo approve --confirm` or approve in `topo view`); otherwise the
default is that you run it yourself.

See `.claude/skills/topo/SKILL.md` for the loop and `.claude/skills/topo/MANIFEST.md`
for the full grammar.
