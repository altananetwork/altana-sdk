/**
 * What `claude mcp add` does with the arguments the credential screen prints.
 *
 * The screen renders a shell command. Nothing proved that the command, once a
 * shell had finished with it, delivered the values the screen meant: the JSON in
 * ALTANA_SESSION carries braces, quotes and commas, and a shell treats every one
 * of them as syntax. The app's own test covers the argument delivery; this is
 * the other half, where those arguments start a real server.
 *
 * So the command runs for real, through bash, with `claude mcp add` replaced by
 * this. It parses what Claude Code parses, writes down what it received for the
 * test to compare against, and execs the server with those variables set. The
 * server's stdio is this process's stdio, so the caller talks to it directly.
 *
 *   bun tests/e2e/mcp-add-stub.ts <name> --env K=V [--env K=V ...] -- <cmd> [args]
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const env: Record<string, string> = {};
let command: string[] = [];

// The server name comes first and Claude Code keeps it; nothing here needs it.
let i = argv[0] && !argv[0].startsWith("-") ? 1 : 0;
for (; i < argv.length; i++) {
  const arg = argv[i]!;
  if (arg === "--") {
    command = argv.slice(i + 1);
    break;
  }
  if (arg === "--env" || arg === "-e") {
    const pair = argv[++i];
    if (pair === undefined) throw new Error("--env with no value");
    /* Split on the first `=` only. A value can contain more of them, and
       ALTANA_SESSION, being JSON, does. */
    const eq = pair.indexOf("=");
    if (eq < 1) throw new Error(`--env needs KEY=VALUE, got ${JSON.stringify(pair)}`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
    continue;
  }
  throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
}

if (command.length === 0) throw new Error("no command after --");

/* What actually arrived, for the test to compare against what the screen
   rendered. Written before exec, because after it this process is gone. */
const echo = process.env.ALTANA_STUB_ECHO;
if (echo) writeFileSync(echo, JSON.stringify({ env, command }, null, 2));

const child = spawn(command[0]!, command.slice(1), {
  env: { ...process.env, ...env },
  stdio: "inherit",
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
