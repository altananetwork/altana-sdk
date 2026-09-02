// Generates pages/changelog.md from the repo's canonical CHANGELOG.md at
// build time (predev/prebuild), so the docs changelog can never go stale.
// Same pattern as the SKILL.md copy. Do not edit pages/changelog.md by hand.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../../CHANGELOG.md"), "utf8");

const page = `---
title: Changelog
description: What shipped in each release of @altananetwork/sdk and @altananetwork/mcp.
---

{/* GENERATED at build time from the repo's CHANGELOG.md — do not edit. */}

${src}
> This page is generated from [\`CHANGELOG.md\`](https://github.com/altananetwork/altana-sdk/blob/main/CHANGELOG.md), the canonical file in the SDK repo.
`;

// The old hand-written page must not shadow the generated one.
rmSync(join(here, "../pages/changelog.mdx"), { force: true });
writeFileSync(join(here, "../pages/changelog.md"), page);
console.log("changelog page generated from ../CHANGELOG.md");
