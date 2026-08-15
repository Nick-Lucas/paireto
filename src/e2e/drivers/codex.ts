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
/** The footer Codex draws once its composer is interactive — the earliest point a keystroke can land. */
const COMPOSER_READY = /\bgpt-[\w.-]+ \w+ · \//;
/** Codex says this when a keystroke arrives while it is still starting its MCP servers. */
const MCP_INTERRUPTED =
  /MCP startup interrupted\. The following servers were not initialized: (.+)/;
const MCP_WATCH_MS = 1_000;
type PlanApprovalTmux = Pick<TmuxSession, "capture" | "sendKeys">;
type ReadyTmux = Pick<TmuxSession, "capture" | "exitStatus">;
type PromptTmux = Pick<TmuxSession, "capture" | "sendKeys" | "typeLine">;

/** Waits, in ms. Overridden by tests so they need not sit out real intervals. */
export interface CodexTimings {
  readyTimeoutMs: number;
  readyPollMs: number;
  /** Identical consecutive frames that end the boot burst of redraws. */
  readyStableFrames: number;
  acceptTimeoutMs: number;
  acceptPollMs: number;
  /** Gap before Enter — Codex drops an Enter that lands in the same tick as a literal paste. */
  submitGapMs: number;
  /** Quiet time after launch before ANY key is sent. The composer becomes interactive while the MCP
   *  servers are still starting, and that startup draws nothing, so a settled screen does not mean
   *  the handshake is done — under load it routinely is not. */
  mcpStartupMs: number;
}

const DEFAULT_TIMINGS: CodexTimings = {
  readyTimeoutMs: 40_000,
  readyPollMs: 1_000,
  readyStableFrames: 3,
  acceptTimeoutMs: 5_000,
  acceptPollMs: 500,
  submitGapMs: 1_500,
  mcpStartupMs: 8_000,
};

export class CodexDriver implements HarnessDriver {
  readonly harness = "codex";
  readonly caps: DriverCaps = {
    turnEndReview: "blocking",
    guidedReviewInvocation: "$paireto-guided-review",
    reviewInvocation: "$paireto-review",
  };

  private home?: HarnessHome;
  private launchedAt = 0;
  private ctx?: DriverContext;
  private stopPaneWatch?: () => void;
  private mcpWatch?: NodeJS.Timeout;
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
    this.launchedAt = Date.now();
    this.stopPaneWatch = startPaneWatch(this.harness, this.tmux, (reason) => {
      this.fatal ??= reason;
    });
    this.watchForInterruptedMcp();
  }

  /** An abandoned MCP startup leaves the session without Paireto's tools, so no gate can ever open.
   *  Report it as the cause the moment Codex says so, rather than at the next step's timeout. */
  private watchForInterruptedMcp(): void {
    this.mcpWatch = setInterval(() => {
      const reason = interruptedMcpReason(this.tmux.capture());
      if (reason) {
        this.fatal ??= reason;
        this.stopMcpWatch();
      }
    }, MCP_WATCH_MS);
  }

  private stopMcpWatch(): void {
    clearInterval(this.mcpWatch);
    this.mcpWatch = undefined;
  }

  async enterPlanMode(): Promise<void> {
    await this.readyToType();
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
    const log = (line: string): void => this.log(line);
    await this.readyToType();
    this.log(`prompt: ${text}`);
    await typeCodexPrompt(this.tmux, text, log);
  }

  /** Settled composer AND the MCP grace window elapsed — both, because a key that lands during the
   *  invisible MCP startup abandons it and leaves the session with none of Paireto's tools. */
  private async readyToType(): Promise<void> {
    await waitForCodexReady(this.tmux, (line) => this.log(line));
    const remaining = DEFAULT_TIMINGS.mcpStartupMs - (Date.now() - this.launchedAt);
    if (remaining > 0) {
      this.log(`readyToType: holding ${remaining}ms more for MCP startup`);
      await delay(remaining);
    }
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
    this.stopMcpWatch();
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

/**
 * A screen where Codex has abandoned its MCP startup, as a failure reason — otherwise undefined.
 * The session then holds none of Paireto's tools, so no gate can ever open and every later step
 * would wait out its budget with the cause buried in the pane.
 */
export function interruptedMcpReason(screen: string): string | undefined {
  const interrupted = MCP_INTERRUPTED.exec(screen);
  return interrupted
    ? `Codex abandoned its MCP startup (${interrupted[1].trim()}), so this session has none of ` +
        "Paireto's tools and no gate can open. A keystroke arrived while it was still starting."
    : undefined;
}

/**
 * Hold every keystroke until the TUI has finished starting. Codex draws its banner, then starts its
 * MCP servers, and a key pressed in that window BOTH abandons that startup and is swallowed — so an
 * early prompt leaves a session with no Paireto tools and an empty composer. Codex prints nothing
 * when the handshake succeeds, so readiness is the interactive composer plus a settled screen: a run
 * of identical frames means the boot burst of redraws is over.
 */
export async function waitForCodexReady(
  tmux: ReadyTmux,
  log: (line: string) => void,
  timings: Partial<CodexTimings> = {},
): Promise<void> {
  const { readyTimeoutMs, readyPollMs, readyStableFrames } = { ...DEFAULT_TIMINGS, ...timings };
  const deadline = Date.now() + readyTimeoutMs;
  let previous: string | undefined;
  let stable = 0;
  do {
    const screen = tmux.capture();
    const exitStatus = tmux.exitStatus();
    if (exitStatus !== undefined) {
      throw new Error(`Codex exited during startup (status ${exitStatus})\n${screen}`);
    }
    stable = screen === previous ? stable + 1 : 0;
    previous = screen;
    if (COMPOSER_READY.test(screen) && stable >= readyStableFrames) {
      log(`waitForReady: composer settled over ${stable} identical frames — ready to type`);
      return;
    }
    if (Date.now() < deadline) {
      await delay(readyPollMs);
    }
  } while (Date.now() < deadline);
  log(`waitForReady: never settled within ${readyTimeoutMs}ms (typing anyway)`);
}

/**
 * Type the prompt, confirm it actually reached the composer, then submit it. A swallowed prompt is
 * otherwise invisible until the step waiting on its result times out, minutes later.
 */
export async function typeCodexPrompt(
  tmux: PromptTmux,
  text: string,
  log: (line: string) => void,
  timings: Partial<CodexTimings> = {},
): Promise<void> {
  const { acceptTimeoutMs, acceptPollMs, submitGapMs } = { ...DEFAULT_TIMINGS, ...timings };
  // Enough of the line to identify it on screen, short enough to survive the pane's wrapping.
  const echo = text.slice(0, 24);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await tmux.typeLine(text, false);
    const deadline = Date.now() + acceptTimeoutMs;
    do {
      if (tmux.capture().includes(echo)) {
        await delay(submitGapMs);
        tmux.sendKeys("Enter");
        return;
      }
      if (Date.now() < deadline) {
        await delay(acceptPollMs);
      }
    } while (Date.now() < deadline);
    log(`prompt attempt ${attempt}: the composer never showed the text — retyping`);
  }
  throw new Error("Codex never accepted the prompt into its composer");
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
