import { BUILD_COMMIT, BUILD_DIRTY, BUILT_AT } from "./buildStamp.js";

/** What code a build of this SDK actually contains. */
export type SdkBuild = {
  /** The source commit it was built from; empty when built outside a repository. */
  commit: string;
  /** Whether the tree had uncommitted changes at build time. */
  dirty: boolean;
  /** When the build ran, ISO 8601. */
  builtAt: string;
  /** `commit` short form plus a `+dirty` marker, or `unknown`. For logs. */
  describe: string;
};

/**
 * The build stamp, for a run to report the code it is running.
 *
 * A consumer resolves this package through `dist`, which is gitignored, so
 * nothing recorded anywhere says what the running artifact contains. On
 * 2026-10-07 the only way to establish which SDK a live spine run had executed
 * was to recognise a distinctive sentence in one of its error messages, and the
 * mechanism first proposed for it — reading the superproject's submodule
 * gitlink — turned out to name the wrong side of the comparison. A run that
 * prints `sdkBuild.describe` does not need either.
 *
 * `dirty` matters as much as `commit`: "built from 92ba3e9" and "built from
 * 92ba3e9 plus uncommitted edits" are different claims, and only the second
 * explains a result the commit alone cannot.
 */
export const sdkBuild: SdkBuild = {
  commit: BUILD_COMMIT,
  dirty: BUILD_DIRTY,
  builtAt: BUILT_AT,
  describe: BUILD_COMMIT ? `${BUILD_COMMIT.slice(0, 7)}${BUILD_DIRTY ? "+dirty" : ""}` : "unknown",
};
