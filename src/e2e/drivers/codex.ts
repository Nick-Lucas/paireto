// Real Codex driver. Runs `codex` in an external tmux session with an isolated temp CODEX_HOME and
// installs the REAL bundled native plugin through the REAL Codex installer. A trusted-project entry
// plus the E2E-only hook-trust bypass keep the run non-interactive. Auth is ~/.codex/auth.json copied
// into the temp home (contents never logged, shredded in dispose).
//
// Plan flow: BTab enters native Plan mode. Send Feedback uses the supported Stop `decision:"block"`
// continuation to revise the plan. Approval must allow Stop and then select Codex's native
// "Implement this plan?" action: Stop hooks cannot change collaboration mode, so the E2E driver
// performs that final TUI action as the simulated user.

import * as fs from "node:fs";
import * as path from "node:path";

import { installCodex } from "../../bridge/CodexInstaller.js";
import { resolveMode } from "../mockserver/mode.js";
import { resolveMockProxy } from "../mockserver/proxyEnv.js";
import { buildCodexHome, mockPath, probeCodex, type HarnessHome } from "../sandbox.js";
import { baseHarnessEnv } from "./harnessEnv.js";
import { TmuxSession, tmuxAvailable, type DriverTmux } from "./tmux.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "./types.js";
import { startPaneWatch } from "./watch.js";

/** Resolved lazily so importing the driver does not touch the filesystem. */
const mockHomeDir = (): string => mockPath("pai-e2e-codex-home");
/** Pinned to keep recordings cheap and replay deterministic. */
const CODEX_MODEL = "gpt-5.6-luna";
const IMPLEMENT_SELECTOR = /implement this plan\?/i;
const PLAN_MODE = /plan mode/i;
type PlanApprovalTmux = Pick<TmuxSession, "capture" | "sendKeys">;

export class CodexDriver implements HarnessDriver {
  readonly harness = "codex";
  readonly caps: DriverCaps = {
    turnEndReview: "blocking",
    guidedReviewInvocation: "$paireto-guided-review",
  };

  private home?: HarnessHome;
  private ctx?: DriverContext;
  private stopPaneWatch?: () => void;
  /** Set by the pane watch when the TUI dies; the test polls fatalError() and aborts. */
  private fatal?: string;

  constructor(private readonly tmux: DriverTmux = new TmuxSession()) {}

  isAvailable(): Promise<boolean | string> {
    if (!tmuxAvailable()) {
      return Promise.resolve("tmux not on PATH");
    }
    return Promise.resolve(probeCodex(resolveMode(process.env)));
  }

  async launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    const mode = resolveMode(process.env);
    const proxy = resolveMockProxy();
    this.home = buildCodexHome({
      checkMode: mode === "check",
      homeDir: mockHomeDir(),
    });
    // Canonicalize the temp CODEX_HOME: Codex trusts hooks by their canonical hooks.json path, so the
    // trust-key path we compute must match what Codex resolves (os.tmpdir() is a /var symlink on mac).
    const codexHome = fs.realpathSync(this.home.env.CODEX_HOME as string);
    this.home.env.CODEX_HOME = codexHome;
    const result = await installCodex(
      {
        pluginsRoot: path.join(repoRoot(), "dist", "plugins"),
        stableDir: path.join(codexHome, "paireto-installer"),
      },
      { codexHome },
    );
    if (!result.ok) {
      throw new Error(result.detail);
    }
    this.writeRuntimeConfig(codexHome, ctx.repoRoot);

    const env = { ...baseHarnessEnv(), ...this.home.env };
    Object.assign(env, proxy.env);
    env.CODEX_CA_CERTIFICATE = proxy.caPath;
    this.log(`mode=${mode}: HTTPS_PROXY=${proxy.url} (+CA trust)`);
    const command = codexLaunchCommand(ctx.repoRoot, process.env.PAIRETO_DOCKER === "1");
    this.log(`launch: ${command} (CODEX_HOME=${codexHome})`);
    this.tmux.launch({ cwd: ctx.repoRoot, env, command });
    this.stopPaneWatch = startPaneWatch(this.harness, this.tmux, (reason) => {
      this.fatal ??= reason;
    });
  }

  async enterPlanMode(): Promise<void> {
    await delay(2500); // let the TUI boot before the key registers
    this.tmux.sendKeys("BTab"); // Shift-Tab cycles to native Plan mode
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (PLAN_MODE.test(this.tmux.capture())) {
        this.log("enterPlanMode: native Plan mode confirmed");
        return;
      }
      await delay(500);
    }
    throw new Error('Codex did not enter native Plan mode after Shift-Tab ("plan mode" not shown)');
  }

  async prompt(text: string): Promise<void> {
    this.log(`prompt: ${text}`);
    await this.tmux.typeLine(text);
  }

  async afterPlanApprove(): Promise<void> {
    await completeNativePlanApproval(this.tmux);
    this.log('afterPlanApprove: selected native "Implement this plan?" approve-and-switch action');
  }

  fatalError(): string | undefined {
    return this.fatal;
  }

  screen(): Promise<string> {
    const wire = (this.ctx?.log ?? []).join("\n");
    const fatal = this.fatal ? `--- driver fatal ---\n${this.fatal}\n` : "";
    return Promise.resolve(`${fatal}${wire}\n--- tmux pane ---\n${this.tmux.capture()}`);
  }

  dispose(): Promise<void> {
    this.stopPaneWatch?.();
    this.tmux.kill();
    this.home?.cleanup();
    return Promise.resolve();
  }

  /** Pin the E2E model, scope the replay/permission overrides, and trust the project, leaving
   *  Codex's native plugin registry alone. */
  private writeRuntimeConfig(codexHome: string, sandboxRepo: string): void {
    const configPath = path.join(codexHome, "config.toml");
    const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
    const config = renderCodexRuntimeConfig(existing, sandboxRepo);
    fs.writeFileSync(configPath, config, "utf8");
    this.log("installed native plugin + replayable provider + trusted sandbox project");
  }

  private log(line: string): void {
    this.ctx?.log.push(`${new Date().toISOString()} [codex] ${line}`);
  }
}

/**
 * Render the E2E config. Root settings come before installer-owned TOML tables: appending `model`
 * after a `[plugins]` table would make it a plugin-table property, and Codex would fall back to the
 * account default model and WebSocket transport.
 *
 * The custom provider and `supports_websockets = false` make every request visible to the HTTP proxy.
 * E2E homes always bypass approval and the inner sandbox; the disposable repo is the test boundary.
 */
export function renderCodexRuntimeConfig(existing: string, project: string): string {
  const rootSettings = [
    `model = "${CODEX_MODEL}"`,
    'model_reasoning_effort = "low"',
    'model_provider = "paireto_openai"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
  ].join("\n");
  const providerTable =
    `\n[model_providers.paireto_openai]\nname = "OpenAI"\n` +
    `base_url = "https://chatgpt.com/backend-api/codex"\nwire_api = "responses"\n` +
    `requires_openai_auth = true\nsupports_websockets = false\n`;
  // Request compression would make recorded bodies opaque to matching.
  const features =
    `\n[features]\napps = false\nplugins = true\nbrowser_use = false\n` +
    `in_app_browser = false\ncomputer_use = false\nimage_generation = false\n` +
    "enable_request_compression = false\n";
  const installerConfig = existing.trim() === "" ? "" : `${existing.trimEnd()}\n\n`;
  return (
    `${rootSettings}\n${providerTable}${features}\n` +
    `${installerConfig}[projects.${tomlKey(project)}]\ntrust_level = "trusted"\n`
  );
}

/** Wait for Codex's native Plan-mode transition UI and select its pre-highlighted implement option.
 *  Paireto approval only releases the Stop hook; no supported hook response can perform this mode
 *  switch. Throwing on timeout makes transport/UI drift fail the E2E instead of faking progress. */
export async function completeNativePlanApproval(
  tmux: PlanApprovalTmux,
  timeoutMs = 90_000,
  pollMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (IMPLEMENT_SELECTOR.test(tmux.capture())) {
      tmux.sendKeys("Enter");
      return;
    }
    if (Date.now() < deadline) {
      await delay(pollMs);
    }
  } while (Date.now() < deadline);
  throw new Error(
    'Codex never presented its native "Implement this plan?" selector after approval',
  );
}

/** The extension repo root (where the shipped plugins/ live). */
function repoRoot(): string {
  return process.env.PAIRETO_REPO_ROOT ?? path.resolve(__dirname, "..", "..", "..");
}

/** TOML basic (double-quoted) key — escape `\` and `"` so any path stays valid TOML. */
function tomlKey(key: string): string {
  return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellQuote(p: string): string {
  return `"${p.replace(/(["$`\\])/g, "\\$1")}"`;
}

/** Docker is already the E2E security boundary and cannot nest Codex's bubblewrap namespace. */
export function codexLaunchCommand(repoRoot: string, docker: boolean): string {
  const dockerPermissions = docker ? "--dangerously-bypass-approvals-and-sandbox " : "";
  return (
    `codex --enable hooks --dangerously-bypass-hook-trust ${dockerPermissions}` +
    `--cd ${shellQuote(repoRoot)}`
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
