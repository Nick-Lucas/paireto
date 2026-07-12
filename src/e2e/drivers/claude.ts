// Real Claude Code driver. Runs `claude` in an external tmux session sharing the sandbox env, with
// the bundled plugin wired via `--plugin-dir`. Auth is an isolated temp CLAUDE_CONFIG_DIR seeded from
// the keychain OAuth credential (or ANTHROPIC_API_KEY in CI) — built by buildClaudeHome, contents
// never logged, shredded in dispose.
//
// afterPlanApprove is regression-independent: a plan-gate allow doesn't always skip Claude's native
// "Would you like to proceed?" prompt, so after approving we capture-pane-poll — key "1" if that
// prompt appears, or proceed if files land first. The path taken is logged.

import * as fs from "node:fs";
import * as path from "node:path";

import { buildClaudeHome, probeClaude, type HarnessHome } from "../sandbox.js";
import { baseHarnessEnv } from "./harnessEnv.js";
import { TmuxSession, tmuxAvailable } from "./tmux.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "./types.js";

const MODEL = "claude-haiku-4-5";
/** capture-pane substrings that mean Claude is showing the native plan prompt (allow didn't skip it). */
const NATIVE_PLAN_PROMPT = /would you like to proceed|ready to execute/i;
// A fresh CLAUDE_CONFIG_DIR shows first-run interstitials that swallow a typed prompt AND leave the
// session out of plan mode if the prompt lands too early. Each needs a DIFFERENT keystroke: the
// "trust this folder" safety check (Enter = "Yes, I trust" — Esc picks "No, exit" and QUITS), and the
// "fullscreen renderer" opt-in (Down+Enter = "Not now", so it never swaps to an alternate screen
// buffer). Readiness is the "plan mode on" footer: only then is --permission-mode plan in effect, so
// ExitPlanMode (hence the plan gate) will fire.
const TRUST_DIALOG = /trust this folder/i;
const FULLSCREEN_DIALOG = /fullscreen renderer|yes, try it/i;
const PLAN_MODE_READY = /plan mode on/i;

export class ClaudeDriver implements HarnessDriver {
  readonly harness = "claudecode";
  readonly caps: DriverCaps = {
    planFeedbackReopens: true,
    turnEndReview: "blocking",
    afterApprove: "tui-select", // native-prompt fallback
  };

  private readonly tmux = new TmuxSession();
  private home?: HarnessHome;
  private ctx?: DriverContext;

  isAvailable(): Promise<boolean | string> {
    if (!tmuxAvailable()) {
      return Promise.resolve("tmux not on PATH");
    }
    return Promise.resolve(probeClaude());
  }

  launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    this.home = buildClaudeHome();
    const pluginDir = path.join(repoRoot(), "plugins", "claude-code");
    const env = { ...baseHarnessEnv(), ...this.home.env };
    const command = [
      "claude",
      "--model",
      MODEL,
      "--permission-mode",
      "plan",
      "--plugin-dir",
      shellQuote(pluginDir),
    ].join(" ");
    this.log(`launch: ${command}`);
    this.tmux.launch({ cwd: ctx.repoRoot, env, command });
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

  async afterPlanApprove(): Promise<void> {
    const repo = this.ctx?.repoRoot;
    const helloPath = repo ? path.join(repo, "hello.txt") : undefined;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (helloPath && fs.existsSync(helloPath)) {
        this.log("afterPlanApprove: files appeared without a native prompt (auto-proceed path)");
        return;
      }
      if (NATIVE_PLAN_PROMPT.test(this.tmux.capture())) {
        this.log('afterPlanApprove: native plan prompt shown — keying "1" (accept-edits fallback)');
        this.tmux.sendKeys("1");
        return;
      }
      await delay(1000);
    }
    this.log("afterPlanApprove: neither files nor native prompt within 90s (test will dump)");
  }

  screen(): Promise<string> {
    const wire = (this.ctx?.log ?? []).join("\n");
    return Promise.resolve(`${wire}\n--- tmux pane ---\n${this.tmux.capture()}`);
  }

  dispose(): Promise<void> {
    this.tmux.kill();
    this.home?.cleanup();
    return Promise.resolve();
  }

  private log(line: string): void {
    this.ctx?.log.push(`${new Date().toISOString()} [claude] ${line}`);
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
