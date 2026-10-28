#!/usr/bin/env bun
/**
 * The `altana-mcp` entry point.
 *
 * One package, three modes:
 *
 *   altana-mcp                  the MCP server on stdio, started by an agent
 *   altana-mcp native-host      the Chrome native messaging host, started by Chrome
 *   altana-mcp install          register both with this machine
 *   altana-mcp uninstall        undo what install wrote
 *
 * This file exists because `index.ts` cannot be imported without starting a
 * server: it connects a StdioServerTransport in top-level code, by design, so
 * the first tool call already sees a session passed in the environment. That
 * makes it the wrong place to look at argv. So argv is read here, and index.ts
 * is imported only when the server is actually what was asked for. `main` and
 * `exports` still point at index.ts, so nothing that imports this package as a
 * library changes.
 *
 * Nothing in this file writes to stdout. In server mode stdout is the JSON-RPC
 * channel and in native-host mode it is the framed message channel; a stray
 * line on either one corrupts a protocol. Help text and errors go to stderr.
 */

// Every import here is dynamic and inside main(), so that choosing a mode never
// pays for the other modes, and above all so that importing index.ts (which
// starts a server the moment it is loaded) happens only when that is what was
// asked for. This empty export is what makes the file a module anyway, which
// top-level await needs.
export {};

const USAGE = `altana-mcp

  altana-mcp                       run the MCP server on stdio (what an agent starts)
  altana-mcp native-host           run the Chrome native messaging host (what Chrome starts)
  altana-mcp install [options]     register the MCP with your agents and the host with Chrome
  altana-mcp uninstall             remove what install wrote
  altana-mcp --version             print the version
  altana-mcp --help                this

install options
  --extension-id <id>   the Chrome extension allowed to connect. Falls back to
                        ALTANA_EXTENSION_ID. Required: a wrong id fails as a
                        silent disconnect, so it is never guessed.
  --client <name>       only set up one client: claude-code, claude-desktop or cursor.
                        Repeatable. Default is every one that is installed.
  --dry-run             print what would be written, write nothing.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    process.stderr.write(USAGE);
    return 0;
  }

  if (command === "--version" || command === "-v") {
    const { VERSION } = await import("./version.js");
    process.stderr.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "native-host") {
    const { runNativeHostOnStdio } = await import("./nativeHost.js");
    await runNativeHostOnStdio();
    return 0;
  }

  if (command === "install" || command === "uninstall") {
    const { runInstallCli } = await import("./install.js");
    return await runInstallCli(command, rest);
  }

  if (command !== undefined && command.startsWith("-")) {
    process.stderr.write(`altana-mcp: no option called ${command}\n\n${USAGE}`);
    return 2;
  }

  if (command !== undefined) {
    process.stderr.write(`altana-mcp: no command called ${command}\n\n${USAGE}`);
    return 2;
  }

  // No arguments: be the MCP server. Importing it is what starts it.
  await import("./index.js");
  return 0;
}

const code = await main(process.argv.slice(2));
// Server and host modes only reach here once their stream has ended, and both
// want the process to end with them.
if (code !== 0) process.exit(code);
