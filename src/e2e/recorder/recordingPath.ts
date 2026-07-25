// The committed-tape path for a harness. In its own module so both the recorder entry point and the
// ReplayDriver can import it without a cycle (index.ts imports ReplayDriver).

import * as path from "node:path";

/** Absolute path of the committed tape for a harness (under the extension dev repo). */
export function recordingPath(harness: string): string {
  const repoRoot = process.env.PAIRETO_REPO_ROOT;
  if (!repoRoot) {
    throw new Error("missing required env PAIRETO_REPO_ROOT");
  }
  return path.join(repoRoot, "src", "e2e", "recordings", `fullflow.${harness}.json`);
}
