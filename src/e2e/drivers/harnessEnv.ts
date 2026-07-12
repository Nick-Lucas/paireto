// Shared env construction for the harness drivers. Every harness process (a tmux server or a spawned
// `opencode serve/run`) gets the SAME hermetic base: the runner's own node dir PINNED first on PATH
// (claude/codex hooks exec `node <script>` and silently fail-open if node isn't resolvable), the
// user's global/system git config neutralized (so a signing hook / identity can't break the sandbox),
// and the SHORT /tmp XDG_STATE_HOME the runner set (the per-repo socket dir must stay under macOS's
// ~104B sun_path limit) propagated through. Per-harness home env (CLAUDE_CONFIG_DIR / CODEX_HOME /
// XDG_CONFIG_HOME+XDG_DATA_HOME) is layered on top by each driver.
//
// Secrets hygiene: this module never reads or logs credential contents — it only shapes PATH + a few
// non-secret vars. Credential COPIES are the per-harness home factory's job (src/e2e/sandbox.ts).

import * as path from "node:path";

/** The dir holding the runner's `node` (passed by runE2E via PAIRETO_NODE_DIR; falls back to the
 *  extension host's own execPath dir, which is Electron — only correct when node happens to be a
 *  sibling, so the explicit var is strongly preferred). */
function nodeBinDir(): string {
  return process.env.PAIRETO_NODE_DIR ?? path.dirname(process.execPath);
}

/**
 * The hermetic base env every harness process inherits. Starts from the current env (so HOME, USER,
 * the terminal locale, etc. survive), then overrides the load-bearing vars. Callers merge their
 * per-harness home env on top (later keys win). Inherited harness-home vars are cleared so a stray
 * outer CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME can't leak the real user config into the run.
 */
export function baseHarnessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Clear anything that could point a harness at the real user config; drivers set their own.
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
  delete env.XDG_CONFIG_HOME;
  delete env.XDG_DATA_HOME;
  env.PATH = `${nodeBinDir()}${path.delimiter}${process.env.PATH ?? ""}`;
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  // XDG_STATE_HOME (socket dir) is inherited from process.env untouched — the runner set the short one.
  return env;
}
