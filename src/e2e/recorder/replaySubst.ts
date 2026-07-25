// Build the replay substitution table for a tape. Placeholders denormalize back to the CURRENT run's
// values: {{REPO}}/{{STATE}}/{{USER_HOME}}/{{REPO_KEY}} come from the sandbox env (buildSubstitutions-
// FromEnv), but harness-home placeholders ({{HHOME1..n}}) have no real home at replay (there's no
// harness), so we mint a throwaway temp dir per distinct index and register them — enough for a codex
// rollout transcript's embedded CODEX_HOME paths (and any opencode config/data home) to denormalize
// to a real, writable path instead of leaving a literal `{{HHOME1}}` in a materialized aux file.

import * as fs from "node:fs";
import * as os from "node:os";

import { buildSubstitutionsFromEnv, type Subst } from "./normalize.js";
import type { Tape } from "./tapeTypes.js";

export interface ReplaySubst {
  subst: Subst;
  /** Remove the minted harness-home temp dirs. */
  cleanup: () => void;
}

/** Count distinct {{HHOMEn}} placeholders in the tape, mint a temp dir for each, and build the subst
 *  with those homes so denormalization is total. */
export function buildReplaySubst(tape: Tape): ReplaySubst {
  const maxIndex = highestHarnessHomeIndex(tape);
  const dirs: string[] = [];
  for (let i = 0; i < maxIndex; i++) {
    dirs.push(fs.mkdtempSync(`${os.tmpdir()}/pai-replay-hhome-`));
  }
  const subst = buildSubstitutionsFromEnv(os.homedir(), dirs.length > 0 ? dirs : undefined);
  return {
    subst,
    cleanup: () => {
      for (const dir of dirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    },
  };
}

/** The highest N across all {{HHOMEn}} placeholders in the tape (0 if none). */
function highestHarnessHomeIndex(tape: Tape): number {
  const text = JSON.stringify(tape);
  let max = 0;
  for (const match of text.matchAll(/\{\{HHOME(\d+)\}\}/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}
