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

import { canonicalize } from "../protocol/paths.js";
import type { E2EMode } from "./mockserver/mode.js";

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

/**
 * Root for the fixed paths a mock run uses. `/private/tmp` is the one location that is canonical on
 * BOTH platforms — macOS resolves `/tmp` to it, and the Linux container can simply create it — so the
 * sandbox and harness homes are spelled identically wherever the run happens. Without that, a cassette
 * recorded in the container carries `/tmp/...` while macOS resolves the same directory to
 * `/private/tmp/...`, and the two disagree in request bodies AND in the harness's own path checks
 * (OpenCode rejects its own worktree as external). Falls back to `/tmp` where `/private` cannot be
 * created, which costs cross-platform replay but keeps the run working.
 */
export function mockTmpRoot(): string {
  try {
    fs.mkdirSync("/private/tmp", { recursive: true });
    return fs.realpathSync("/private/tmp") === "/private/tmp" ? "/private/tmp" : "/tmp";
  } catch {
    return "/tmp";
  }
}

const FIXED_MOCK_NAMES = new Set([
  "paireto-e2e-claudecode",
  "paireto-e2e-codex",
  "paireto-e2e-opencode",
  "paireto-e2e-sandbox-root-test",
  "pai-e2e-claude-home",
  "pai-e2e-codex-home",
  "pai-e2e-opencode-home",
]);

/** A fixed, cross-platform-stable path for a mock run's sandbox or harness home. */
export function mockPath(name: string): string {
  if (!FIXED_MOCK_NAMES.has(name)) {
    throw new Error(`fixed E2E path is outside the owned mock-run namespace: ${name}`);
  }
  return path.join(mockTmpRoot(), name);
}

function assertFixedMockPath(target: string): void {
  const root = mockTmpRoot();
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== root || !FIXED_MOCK_NAMES.has(path.basename(resolved))) {
    throw new Error(`fixed E2E path is outside the owned mock-run namespace: ${target}`);
  }
  if (fs.existsSync(resolved) && fs.realpathSync(resolved) !== resolved) {
    throw new Error(`fixed E2E path must not follow a symlink: ${target}`);
  }
}

function prepareFixedMockDir(target: string): void {
  assertFixedMockPath(target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
}

export interface SandboxOptions {
  /**
   * Pin the repo to a FIXED path instead of a random mkdtemp one. Required for record/check runs:
   * harnesses embed the absolute cwd in their provider requests, so a stable path is what lets a
   * recorded fixture match on replay. `undefined` is available for isolated unit tests.
   */
  fixedRepoRoot?: string;
}

export function createSandbox(opts: SandboxOptions = {}): Sandbox {
  // Repo can live anywhere (only its hash keys the socket); the STATE dir is what must be short.
  const created = opts.fixedRepoRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-repo-"));
  if (opts.fixedRepoRoot) {
    prepareFixedMockDir(opts.fixedRepoRoot);
  }
  // ONE spelling of the project path for the whole run. `git rev-parse` and the harnesses resolve
  // symlinks (macOS /tmp -> /private/tmp), so handing anyone the unresolved form makes the agent's
  // cwd, the extension's repo root and the paths in tool calls disagree — which is not a shape a
  // user's session ever has. `repoKey` already hashes the canonical path, so sockets are unaffected.
  const repoRoot = canonicalize(created);
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
        if (opts.fixedRepoRoot && dir === repoRoot) {
          assertFixedMockPath(dir);
        }
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

/** The Claude config file — overridable so a container can point at a host-staged copy (the macOS
 *  keychain is unavailable in Linux; see docker/prepare-e2e.sh). Defaults to the real ~/.claude.json. */
function claudeConfigPath(): string {
  return process.env.PAIRETO_CLAUDE_CONFIG ?? path.join(os.homedir(), ".claude.json");
}

/** True iff the path is a non-empty file (an empty placeholder mount counts as absent). */
function hasContent(p: string): boolean {
  try {
    return fs.statSync(p).size > 0;
  } catch {
    return false;
  }
}

/**
 * Seed a HERMETIC `.claude.json` for the sandbox: the real config with the user's MCP servers and
 * project history STRIPPED. Without this the E2E Claude loads every third-party MCP server the user has
 * configured (Notion, Stripe, …) — auth prompts, and (under the record proxy) a flood of mcp-registry /
 * settings / event-logging traffic that bloats and destabilises fixtures. Onboarding flags survive, so
 * no interstitials beyond trust/fullscreen (which the driver clears). No-op when there's no source config
 * (fresh CI home → the driver walks the first-run dialogs).
 */
function seedClaudeConfig(destDir: string): void {
  const src = claudeConfigPath();
  if (!hasContent(src)) {
    return;
  }
  const cfg = JSON.parse(fs.readFileSync(src, "utf8")) as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (key === "projects" || /mcp/i.test(key)) {
      delete cfg[key];
    }
  }
  const dest = path.join(destDir, ".claude.json");
  fs.writeFileSync(dest, JSON.stringify(cfg));
  fs.chmodSync(dest, 0o600);
}

/**
 * Write a FAKE, far-future OAuth credential so check-mode Claude is locally "logged in" and actually
 * sends requests — MockServer ignores the token value and SIMULATE-replays the fixture, and the
 * year-2100 expiry means Claude never attempts a refresh (which would 599, since a fresh record never
 * refreshes). This is what makes check durable and credential-free. NOT a real credential.
 */
function seedFakeClaudeCredentials(destDir: string): void {
  const cred = {
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-paireto-e2e-check-fake-access",
      refreshToken: "sk-ant-ort01-paireto-e2e-check-fake-refresh",
      expiresAt: 4102444800000, // 2100-01-01
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default",
    },
  };
  const dest = path.join(destDir, ".credentials.json");
  fs.writeFileSync(dest, JSON.stringify(cred));
  fs.chmodSync(dest, 0o600);
}

/** A fresh config shows the login-method selector before consulting credentials. Check mode needs
 *  only the non-secret local onboarding/account identity that a completed OAuth login would cache. */
function seedFakeClaudeConfig(destDir: string): void {
  const dest = path.join(destDir, ".claude.json");
  const cfg = hasContent(dest)
    ? (JSON.parse(fs.readFileSync(dest, "utf8")) as Record<string, unknown>)
    : {};
  Object.assign(cfg, {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: "2.1.220",
    oauthAccount: {
      accountUuid: "00000000-0000-4000-8000-0000000000c4",
      emailAddress: "paireto-e2e@example.invalid",
      organizationUuid: "00000000-0000-4000-8000-0000000000c5",
      hasExtraUsageEnabled: false,
      billingType: "subscription",
      profileFetchedAt: 4102444800000,
    },
  });
  fs.writeFileSync(dest, JSON.stringify(cfg));
  fs.chmodSync(dest, 0o600);
}

// In `check` mode the harness talks only to MockServer (fixture replay), so NO provider credential is
// needed — availability is just the binary being on PATH. Record still requires real auth.
export function probeClaude(mode: E2EMode = "record"): Availability {
  if (!onPath("claude")) {
    return "claude binary not on PATH";
  }
  if (mode === "check") {
    return true;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return true;
  }
  if (!hasContent(claudeConfigPath())) {
    return "no Claude config (ANTHROPIC_API_KEY, ~/.claude.json, or staged PAIRETO_CLAUDE_CONFIG)";
  }
  return true;
}

export function probeCodex(mode: E2EMode = "record"): Availability {
  if (!onPath("codex")) {
    return "codex binary not on PATH";
  }
  if (mode === "check") {
    return true;
  }
  return fs.existsSync(path.join(os.homedir(), ".codex", "auth.json"))
    ? true
    : "no ~/.codex/auth.json";
}

export function probeOpenCode(mode: E2EMode = "record"): Availability {
  if (!onPath("opencode")) {
    return "opencode binary not on PATH";
  }
  if (mode === "check") {
    return true;
  }
  const dataAuth = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  return fs.existsSync(dataAuth) ? true : "no opencode auth.json";
}

/**
 * Build an isolated claude home: temp CLAUDE_CONFIG_DIR seeded from the Claude config + the OAuth
 * credential (or ANTHROPIC_API_KEY when present, for CI). The credential comes from a host-staged
 * file when PAIRETO_CLAUDE_CREDENTIALS points at one (Docker — no keychain in Linux; see
 * docker/prepare-e2e.sh), else from the macOS keychain. Plugin is wired at launch via
 * `--plugin-dir <repo>/dist/plugins/claude-code`.
 */
export function buildClaudeHome(opts: { checkMode?: boolean; homeDir?: string } = {}): HarnessHome {
  // Pin CLAUDE_CONFIG_DIR when requested so its embedded path is stable between record and check.
  const dir = opts.homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-claude-"));
  if (opts.homeDir) {
    prepareFixedMockDir(opts.homeDir);
  }
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: dir };
  // check mode: hermetic config + a FAKE far-future OAuth credential so Claude is "logged in" and sends
  // the requests the fixture answers, while the proxy + MockServer SIMULATE keep it fully offline (the
  // real backend is never reached). Durable and credential-free; record below uses the real OAuth
  // subscription.
  if (opts.checkMode) {
    seedClaudeConfig(dir);
    seedFakeClaudeConfig(dir);
    seedFakeClaudeCredentials(dir);
    return { env, cleanup: () => rm(dir, Boolean(opts.homeDir)) };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    seedClaudeConfig(dir);
    const credOverride = process.env.PAIRETO_CLAUDE_CREDENTIALS;
    if (credOverride && hasContent(credOverride)) {
      // Host-staged OAuth credential (contents never printed).
      copySecret(credOverride, path.join(dir, ".credentials.json"));
    } else {
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
  }
  return { env, cleanup: () => rm(dir, Boolean(opts.homeDir)) };
}

/**
 * Build an isolated codex home: temp CODEX_HOME with ~/.codex/auth.json copied in, hooks enabled,
 * and the project trusted. The hooks.json + trust-hash + trust-level wiring is the driver's job (it
 * uses the real native Codex plugin installer); this only lays down the isolated home + auth.
 */
export function buildCodexHome(opts: { checkMode?: boolean; homeDir?: string } = {}): HarnessHome {
  const dir = opts.homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-codex-"));
  if (opts.homeDir) {
    prepareFixedMockDir(opts.homeDir);
  }
  const authPath = path.join(dir, "auth.json");
  if (opts.checkMode) {
    const accountId = "00000000-0000-4000-8000-0000000000c2";
    const token = fakeJwt({
      sub: "paireto-e2e-check",
      exp: 4102444800, // 2100-01-01
      email: "paireto-e2e@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: "pro",
      },
    });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: token,
          access_token: token,
          refresh_token: "paireto-e2e-check-fake-refresh",
          account_id: accountId,
        },
        last_refresh: new Date().toISOString(),
      }),
    );
    fs.chmodSync(authPath, 0o600);
  } else {
    const srcAuth = path.join(os.homedir(), ".codex", "auth.json");
    if (fs.existsSync(srcAuth)) {
      copySecret(srcAuth, authPath);
    }
  }
  return { env: { CODEX_HOME: dir }, cleanup: () => rm(dir, Boolean(opts.homeDir)) };
}

/**
 * Build an isolated opencode home: temp XDG_CONFIG_HOME + XDG_DATA_HOME with auth.json copied into
 * the data home. Plugin + opencode.json + auth-plugin copying is the driver's job.
 */
export function buildOpenCodeHome(
  opts: { checkMode?: boolean; homeDir?: string } = {},
): HarnessHome {
  const dir = opts.homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pai-e2e-opencode-"));
  if (opts.homeDir) {
    prepareFixedMockDir(opts.homeDir);
  }
  const configHome = path.join(dir, "config");
  const dataHome = path.join(dir, "data");
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(dataHome, { recursive: true });
  const authPath = path.join(dataHome, "opencode", "auth.json");
  if (opts.checkMode) {
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(
      authPath,
      JSON.stringify({
        openai: {
          type: "oauth",
          refresh: "paireto-e2e-check-fake-refresh",
          access: fakeJwt({ sub: "paireto-e2e-check", exp: 4102444800 }),
          expires: 4102444800000,
          accountId: "00000000-0000-4000-8000-0000000000c3",
        },
      }),
    );
    fs.chmodSync(authPath, 0o600);
  } else {
    const srcAuth = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
    if (fs.existsSync(srcAuth)) {
      copySecret(srcAuth, authPath);
    }
  }
  return {
    env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome },
    cleanup: () => rm(dir, Boolean(opts.homeDir)),
  };
}

/** Syntactically valid, unsigned test JWT. Replay never sends it beyond strict MockServer SIMULATE. */
function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.paireto-e2e`;
}

function rm(dir: string, fixed = false): void {
  try {
    if (fixed) {
      assertFixedMockPath(dir);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
