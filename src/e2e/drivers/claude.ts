// Real Claude Code driver. Runs `claude` in an external tmux session sharing the sandbox env, with
// the bundled plugin wired via `--plugin-dir`. Auth is an isolated temp CLAUDE_CONFIG_DIR seeded from
// the keychain OAuth credential (or ANTHROPIC_API_KEY in CI) — built by buildClaudeHome, contents
// never logged, shredded in dispose.
//
import * as path from "node:path";

import { resolveMode } from "../mockserver/mode.js";
import { resolveMockProxy } from "../mockserver/proxyEnv.js";
import { buildClaudeHome, mockPath, probeClaude, type HarnessHome } from "../sandbox.js";
import { STEP_TIMEOUT_MS } from "../testUtils.js";
import { baseHarnessEnv } from "./harnessEnv.js";
import { TmuxSession, tmuxAvailable, type DriverTmux } from "./tmux.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "./types.js";
import { startPaneWatch } from "./watch.js";

const MODEL = "claude-haiku-4-5";
/** Fixed home + session id → the config-dir path and any session-derived values (e.g. the
 *  plan-file slug) Claude embeds in messages are the SAME in record and check, so bodies match.
 *  Resolved lazily so importing the driver does not touch the filesystem. */
const mockHomeDir = (): string => mockPath("pai-e2e-claude-home");
const MOCK_SESSION_ID = "00000000-0000-4000-8000-0000000000c1";
// A fresh CLAUDE_CONFIG_DIR shows first-run interstitials that swallow a typed prompt AND leave the
// session out of plan mode if the prompt lands too early. Each needs a DIFFERENT keystroke: the
// "trust this folder" safety check (Enter = "Yes, I trust" — Esc picks "No, exit" and QUITS), and the
// "fullscreen renderer" opt-in (Down+Enter = "Not now", so it never swaps to an alternate screen
// buffer). Readiness is the "plan mode on" footer: only then is --permission-mode plan in effect, so
// ExitPlanMode (hence the plan gate) will fire.
const TRUST_DIALOG = /trust this folder/i;
const FULLSCREEN_DIALOG = /fullscreen renderer|yes, try it/i;
const PLAN_MODE_READY = /plan mode on/i;
const PLAN_FILE_PERMISSION = /allow all edits[^\n]*plans\//i;
const PLAN_FILE_EDIT_PERMISSION = /do you want to make this edit to plan-[^?\n]+\.md\?/i;
/** Each poll spawns a `tmux capture-pane` subprocess and this runs for the whole test, so keep the
 *  cadence human-scale. The prompt it watches for stays on screen until answered. */
const PERMISSION_POLL_MS = 500;
/** A provider-backed run's prompt takes a beat to clear. A fraction of the step budget covers that while
 *  staying inside the step this serves. */
const PROMPT_ACCEPT_TIMEOUT_MS = STEP_TIMEOUT_MS / 4;

export class ClaudeDriver implements HarnessDriver {
  readonly harness = "claudecode";
  readonly caps: DriverCaps = {
    turnEndReview: "blocking",
  };

  private home?: HarnessHome;
  private ctx?: DriverContext;
  private planFilePermissionWatcher?: NodeJS.Timeout;
  private stopPaneWatch?: () => void;
  /** Set by the background permission watcher when the run can no longer mirror a user's session.
   *  The test polls fatalError() and aborts. */
  private fatal?: string;

  constructor(private readonly tmux: DriverTmux = new TmuxSession()) {}

  isAvailable(): Promise<boolean | string> {
    if (!tmuxAvailable()) {
      return Promise.resolve("tmux not on PATH");
    }
    return Promise.resolve(probeClaude(resolveMode(process.env)));
  }

  launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    const mode = resolveMode(process.env);
    const proxy = resolveMockProxy();
    this.home = buildClaudeHome({
      checkMode: mode === "check",
      homeDir: mockHomeDir(),
    });
    const pluginDir = path.join(repoRoot(), "plugins", "claude-code");
    const env = { ...baseHarnessEnv(), ...this.home.env };
    // Keep the run hermetic: no telemetry / autoupdate / error reporting / non-essential cloud calls,
    // so a recording captures only the model inference traffic (not a flood of settings/registry noise).
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    env.DISABLE_TELEMETRY = "1";
    env.DISABLE_ERROR_REPORTING = "1";
    env.DISABLE_AUTOUPDATER = "1";
    // Record keeps Claude's real OAuth token; check uses the fake local credential from buildClaudeHome.
    Object.assign(env, proxy.env);
    this.log(`mode=${mode}: HTTPS_PROXY=${proxy.url} (+CA trust)`);
    const command = [
      "claude",
      "--model",
      MODEL,
      "--permission-mode",
      "plan",
      // Load NO external (account/user/project) MCP servers: their tool set varies run-to-run and
      // Claude lists it in a `<system-reminder>` inside the first user message, so it would make every
      // /v1/messages body non-reproducible for replay. Also removes all /v1/mcp* traffic from fixtures.
      "--strict-mcp-config",
      // A fixed session id keeps session-derived values (the plan-file slug Claude embeds in
      // the first message) are identical between record and check.
      "--session-id",
      MOCK_SESSION_ID,
      "--plugin-dir",
      shellQuote(pluginDir),
    ].join(" ");
    this.log(`launch: ${command}`);
    this.tmux.launch({ cwd: ctx.repoRoot, env, command });
    this.stopPaneWatch = startPaneWatch(this.harness, this.tmux, (reason) => {
      this.fatal ??= reason;
    });
    this.watchForPlanFilePermission();
    return Promise.resolve();
  }

  enterPlanMode(): Promise<void> {
    // --permission-mode plan at launch already put the session in plan mode.
    return Promise.resolve();
  }

  async prompt(text: string): Promise<void> {
    await this.waitForPlanModeReady();
    this.log(`prompt: ${text}`);
    await this.tmux.typeLine(text);
  }

  /** Clear first-run interstitials and wait for the "plan mode on" footer before typing — typing while
   *  a dialog is up (or before plan mode is in effect) drops the prompt / lands it in the wrong mode,
   *  and then the model answers directly instead of calling ExitPlanMode (no plan gate). */
  private async waitForPlanModeReady(): Promise<void> {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const screen = this.tmux.capture();
      const exitStatus = this.tmux.exitStatus();
      if (exitStatus !== undefined) {
        throw new Error(`Claude exited during startup (status ${exitStatus})\n${screen}`);
      }
      if (PLAN_MODE_READY.test(screen)) {
        this.log("waitForPlanModeReady: plan mode on — ready to prompt");
        return;
      }
      if (TRUST_DIALOG.test(screen)) {
        this.log('waitForPlanModeReady: trust dialog — Enter (option 1 "Yes, I trust")');
        this.tmux.sendKeys("Enter");
      } else if (FULLSCREEN_DIALOG.test(screen)) {
        this.log('waitForPlanModeReady: fullscreen dialog — Down+Enter (option 2 "Not now")');
        this.tmux.sendKeys("Down");
        this.tmux.sendKeys("Enter");
      }
      await delay(1200);
    }
    this.log("waitForPlanModeReady: 'plan mode on' never appeared within 40s (typing anyway)");
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
    if (this.planFilePermissionWatcher) {
      clearInterval(this.planFilePermissionWatcher);
      this.planFilePermissionWatcher = undefined;
    }
    this.tmux.kill();
    this.home?.cleanup();
    return Promise.resolve();
  }

  private log(line: string): void {
    this.ctx?.log.push(`${new Date().toISOString()} [claude] ${line}`);
  }

  /** Claude writes its plan markdown before calling ExitPlanMode and can ask permission for that
   *  plans/ write. Answer it as a user in plan mode would, allowing this one edit, which leaves the
   *  session in plan mode. */
  private watchForPlanFilePermission(): void {
    let handledVisiblePrompt = false;
    this.planFilePermissionWatcher = setInterval(() => {
      const screen = this.tmux.capture();
      const visible = PLAN_FILE_PERMISSION.test(screen) || PLAN_FILE_EDIT_PERMISSION.test(screen);
      if (!visible) {
        handledVisiblePrompt = false;
        return;
      }
      if (handledVisiblePrompt) {
        return;
      }
      handledVisiblePrompt = true;
      this.log('plan-file permission prompt shown — keying "1" (allow this edit)');
      this.tmux.sendKeys("1");
      void this.assertPromptAccepted();
    }, PERMISSION_POLL_MS);
  }

  /**
   * Confirm the answer landed. Claude blocks while a permission prompt is pending, so a prompt still
   * on screen means its options have moved on from what the driver answers and every later step is
   * waiting on an agent that will never move. This holds in every phase of the run, whereas the
   * permission mode legitimately changes when Paireto approves a plan.
   */
  private async assertPromptAccepted(): Promise<void> {
    const deadline = Date.now() + PROMPT_ACCEPT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(PERMISSION_POLL_MS);
      const screen = this.tmux.capture();
      if (!PLAN_FILE_PERMISSION.test(screen) && !PLAN_FILE_EDIT_PERMISSION.test(screen)) {
        this.log("plan-file permission prompt accepted");
        return;
      }
    }
    this.fatal =
      `the plan-file permission prompt was still on screen ${PROMPT_ACCEPT_TIMEOUT_MS}ms after ` +
      'answering it with "1" — its options have changed, so the driver is no longer answering it ' +
      "the way a user would and the agent is blocked";
    this.log(`FATAL: ${this.fatal}`);
  }
}

/** The extension repo root (where the shipped plugins/ live) — NOT the sandbox repo. */
function repoRoot(): string {
  return process.env.PAIRETO_REPO_ROOT ?? path.resolve(__dirname, "..", "..", "..");
}

/** Wrap a path in double quotes for the /bin/sh -c command line (handles spaces in the repo path). */
function shellQuote(p: string): string {
  return `"${p.replace(/(["$`\\])/g, "\\$1")}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
