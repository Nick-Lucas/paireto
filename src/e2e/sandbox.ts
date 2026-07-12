// E2E sandbox factory (runs in the HOST node process — NO vscode import). Builds a throwaway git
// repo with Paireto settings seeded, a SHORT /tmp XDG_STATE_HOME (macOS sun_path ~104B limit — a
// scratchpad-length socket dir EINVALs), and a fresh --user-data-dir. Also builds the per-harness
// home factory (claude/codex/opencode) + availability probes.
//
// Secrets hygiene: any credential material is copied into the run's temp dir ONLY, chmod 600, its
// contents NEVER logged, and the whole tree is removed in teardown.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Sandbox {
  /** The git repo VS Code opens (launchArgs[0]); also the agent cwd. */
  repoRoot: string;
  /** Short /tmp XDG_STATE_HOME — the socket dir must stay under the sun_path limit. */
  stateHome: string;
  /** Fresh VS Code user-data dir (isolation). */
  userDataDir: string;
  /** Remove every temp dir this sandbox created (best-effort). */
  cleanup(): void;
}

/** Git env that ignores the user's global/system config so signing hooks / identities can't break
 *  the sandbox commit. */
const HERMETIC_GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
};

/** Paireto settings seeded into the sandbox .vscode/settings.json. */
const SANDBOX_SETTINGS: Record<string, unknown> = {
  "paireto.notify.type": "disabled",
  "paireto.review.mode": "automatic",
  "paireto.planApprove.mode.claudecode": "acceptEdits",
  "paireto.planApprove.mode.opencode": "build",
  "paireto.logLevel": "debug",
  // Keep VS Code quiet + deterministic during the run.
  "workbench.startupEditor": "none",
  "git.openRepositoryInParentFolders": "always",
};

export function createSandbox(): Sandbox {
  // Repo can live anywhere (only its hash keys the socket); the STATE dir is what must be short.
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-repo-"));
  const stateHome = fs.mkdtempSync("/tmp/pai-"); // SHORT — see the header note
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-ud-"));

  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: repoRoot, env: HERMETIC_GIT_ENV, stdio: "ignore" });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "e2e@paireto.test"]);
  git(["config", "user.name", "Paireto E2E"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "core.hooksPath", "/dev/null"]);

  fs.mkdirSync(path.join(repoRoot, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, ".vscode", "settings.json"),
    JSON.stringify(SANDBOX_SETTINGS, null, 2),
  );
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# E2E sandbox\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "initial"]);

  const cleanup = (): void => {
    for (const dir of [repoRoot, stateHome, userDataDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  };

  return { repoRoot, stateHome, userDataDir, cleanup };
}

// --- Per-harness home factory -------------------------------------------------------------------

export interface HarnessHome {
  /** Extra env the harness's TUI needs (CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME …). */
  env: NodeJS.ProcessEnv;
  /** Remove the temp home (shreds copied credentials). */
  cleanup(): void;
}

/** True (available) or a human-readable skip reason. A harness whose auth material / binary is
 *  missing is SKIPPED with a visible notice, never failed. */
export type Availability = true | string;

/** Is a binary on PATH? */
function onPath(bin: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Copy a credential file into the temp home with 0600 perms; never touch/log its contents. */
function copySecret(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
}

export function probeClaude(): Availability {
  if (process.env.ANTHROPIC_API_KEY) {
    return onPath("claude") ? true : "claude binary not on PATH";
  }
  const home = os.homedir();
  const hasConfig = fs.existsSync(path.join(home, ".claude.json"));
  if (!hasConfig) {
    return "no ~/.claude.json and no ANTHROPIC_API_KEY";
  }
  return onPath("claude") ? true : "claude binary not on PATH";
}

export function probeCodex(): Availability {
  if (!onPath("codex")) {
    return "codex binary not on PATH";
  }
  return fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"))
    ? true
    : "no ~/.codex/auth.json";
}

export function probeOpenCode(): Availability {
  if (!onPath("opencode")) {
    return "opencode binary not on PATH";
  }
  const dataAuth = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  return fs.existsSync(dataAuth) ? true : "no opencode auth.json";
}

/**
 * Build an isolated claude home: temp CLAUDE_CONFIG_DIR seeded from ~/.claude.json + the keychain
 * credential (or ANTHROPIC_API_KEY when present, for CI). Plugin is wired at launch via
 * `--plugin-dir <repo>/plugins/claude-code`.
 */
export function buildClaudeHome(): HarnessHome {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-claude-"));
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: dir };
  if (!process.env.ANTHROPIC_API_KEY) {
    const srcConfig = path.join(os.homedir(), ".claude.json");
    if (fs.existsSync(srcConfig)) {
      copySecret(srcConfig, path.join(dir, ".claude.json"));
    }
    try {
      // Keychain OAuth credential -> .credentials.json (never printed).
      const cred = execFileSync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { encoding: "utf8" },
      );
      const credPath = path.join(dir, ".credentials.json");
      fs.writeFileSync(credPath, cred);
      fs.chmodSync(credPath, 0o600);
    } catch {
      /* no keychain credential — the probe already decided availability */
    }
  }
  return { env, cleanup: () => rm(dir) };
}

/**
 * Build an isolated codex home: temp CODEX_HOME with ~/.codex/auth.json copied in, hooks enabled,
 * and the project trusted. The hooks.json + trust-hash + trust-level wiring is the driver's job (it
 * uses the real CodexInstaller pure functions); this only lays down the isolated home + auth.
 */
export function buildCodexHome(): HarnessHome {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-codex-"));
  const srcAuth = path.join(os.homedir(), ".codex", "auth.json");
  if (fs.existsSync(srcAuth)) {
    copySecret(srcAuth, path.join(dir, "auth.json"));
  }
  return { env: { CODEX_HOME: dir }, cleanup: () => rm(dir) };
}

/**
 * Build an isolated opencode home: temp XDG_CONFIG_HOME + XDG_DATA_HOME with auth.json copied into
 * the data home. Plugin + opencode.json + auth-plugin copying is the driver's job.
 */
export function buildOpenCodeHome(): HarnessHome {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-opencode-"));
  const configHome = path.join(dir, "config");
  const dataHome = path.join(dir, "data");
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  const srcAuth = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  if (fs.existsSync(srcAuth)) {
    copySecret(srcAuth, path.join(dataHome, "opencode", "auth.json"));
  }
  return {
    env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
    cleanup: () => rm(dir),
  };
}

function rm(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
