/**
 * Starting anvil, and saying why when it will not start.
 *
 * Every fork test spawned anvil with `stderr: "ignore"` and then probed the
 * port until it answered, so a failure could only ever say "anvil did not
 * become ready": thirty seconds of silence and no cause. On 2026-10-28 the
 * Base fork failed exactly that way on three branches in a row, and the reason
 * was unreadable in CI although anvil had printed it in the first second and
 * exited:
 *
 *     Error: failed to get fork block number
 *     Context:
 *       - HTTP error 404 with body: invalid method
 *
 * So this keeps anvil's stderr, notices that it has exited instead of waiting
 * out the clock, and puts its last words in the error.
 *
 * The fork URL is never printed: it carries an API key. anvil quotes it back
 * in some of its errors ("error sending request for url (…)"), which is why
 * every URL in what it says is replaced before the text is shown — redacting
 * only our own variable would miss the copy anvil kept.
 */
import { createPublicClient, http } from "viem";

/** Enough of anvil's stderr to explain itself, not enough to bloat a log. */
const KEEP_LINES = 20;
const KEEP_BYTES = 8_192;

/**
 * Every URL replaced by `<url>`. Deliberately greedy about what a URL is: a
 * key leaked into a CI log cannot be taken back, and no fork test needs the
 * URL printed to be diagnosed — the script says which chain it is forking.
 */
export function withoutUrls(text: string): string {
  // Trailing sentence punctuation is kept: a URL may contain a dot or a comma
  // but does not end a sentence, and eating the full stop makes the rest of
  // the line read like a truncation.
  return text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]}]+/gi, (m) => `<url>${/[.,;:!?]+$/.exec(m)?.[0] ?? ""}`);
}

export type Anvil = {
  /** Stop it. Safe to call in a `finally` whether or not it ever started. */
  kill: () => void;
  /** Where it listens: no secret, so this one is safe to print. */
  url: string;
  port: number;
  /** What it has said on stderr, last {@link KEEP_LINES} lines, URLs removed. */
  said: () => string;
  /** Its exit code once it has exited; `undefined` while it is running. */
  exitCode: () => number | undefined;
};

/**
 * Fork `forkUrl` on `port`. `args` replaces the usual `--silent` for a caller
 * that needs different ones (fork-native-receive wants `--hardfork prague`).
 */
export function startAnvil(forkUrl: string, port: number, args: readonly string[] = ["--silent"]): Anvil {
  // Said here, because `Bun.spawn` answers a missing binary with an ENOENT
  // stack trace pointing at this file, which reads like a bug in the harness.
  if (!Bun.which("anvil")) {
    throw new Error("anvil is not on PATH: the fork tests need foundry (https://getfoundry.sh)");
  }
  const proc = Bun.spawn(["anvil", "--fork-url", forkUrl, "--port", String(port), ...args], {
    stdout: "ignore",
    stderr: "pipe",
  });
  let kept = "";
  let code: number | undefined;
  // Drained as it arrives, for two reasons: a full pipe would block anvil,
  // and the text is wanted at the moment of failure rather than after the
  // process has been reaped.
  void (async () => {
    const decoder = new TextDecoder();
    // A reader rather than `for await`: Bun's stream is async-iterable at
    // runtime, but the DOM typing this package compiles against is not.
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) kept = `${kept}${decoder.decode(value, { stream: true })}`.slice(-KEEP_BYTES);
      }
    } catch {
      /* the process went away mid-read; whatever arrived is what we have */
    }
  })();
  void proc.exited.then((c) => {
    code = c;
  });
  return {
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
    url: `http://127.0.0.1:${port}`,
    port,
    said: () => withoutUrls(kept).trim().split("\n").slice(-KEEP_LINES).join("\n"),
    exitCode: () => code,
  };
}

/**
 * Wait until `probe` answers — by default a `getBlockNumber` against anvil's
 * own port. Throws with anvil's words when it does not, and gives up as soon
 * as anvil has exited rather than probing a port nothing is listening on.
 */
export async function waitForAnvil(
  anvil: Anvil,
  probe?: () => Promise<unknown>,
  opts: { attempts?: number; everyMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 60;
  const everyMs = opts.everyMs ?? 500;
  const ask = probe ?? (() => createPublicClient({ transport: http(anvil.url) }).getBlockNumber());
  const failed = () => {
    const code = anvil.exitCode();
    const what =
      code === undefined
        ? `it never answered on port ${anvil.port} within ${Math.round((attempts * everyMs) / 1000)}s`
        : `it exited with code ${code}`;
    const said = anvil.said();
    return new Error(
      `anvil did not become ready: ${what}. ` +
        (said
          ? `anvil said:\n${said}`
          : "anvil said nothing on stderr — check that `anvil` is on PATH and that the fork RPC answers"),
    );
  };
  for (let i = 0; i < attempts; i++) {
    try {
      await ask();
      return;
    } catch {
      if (anvil.exitCode() !== undefined) throw failed();
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
  throw failed();
}
