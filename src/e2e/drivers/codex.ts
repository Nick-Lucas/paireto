// Real Codex driver. Runs `codex` in an external tmux session with an isolated temp CODEX_HOME whose
// hooks.json + config.toml are built by the REAL CodexInstaller pure functions plus a
// `[projects."<repo>"] trust_level = "trusted"` entry so implementation runs with ZERO approval
// prompts. Auth is ~/.codex/auth.json copied into the temp home (contents never logged, shredded in
// dispose).
//
// Plan flow: BTab enters plan mode; after the test approves the plan Stop, Codex shows an "Implement
// this plan?" selector with option 1 pre-highlighted — afterPlanApprove capture-pane-waits for it and
// presses Enter. Send-Feedback (deny) revises the plan in-place under stop_hook_active, re-reviewed as
// a fresh plan gate.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  appendCodexTrust,
  codexTrustEntries,
  ensureCodexFeaturesHooks,
  mergeCodexHooks,
  resolveCodexGroups,
} from "../../bridge/CodexInstaller.js";
import { getRecordContext } from "../recorder/recordContext.js";
import { shimHookCommand } from "../recorder/recordSandbox.js";
import { buildCodexHome, probeCodex, type HarnessHome } from "../sandbox.js";
import { baseHarnessEnv } from "./harnessEnv.js";
import { TmuxSession, tmuxAvailable } from "./tmux.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "./types.js";

/** capture-pane substring that means the post-approve implement selector is up (Enter picks option 1). */
const IMPLEMENT_SELECTOR = /implement this plan\?/i;
/** capture-pane substring confirming plan mode is active after BTab. */
const PLAN_MODE = /plan mode/i;

export class CodexDriver implements HarnessDriver {
  readonly harness = "codex";
  readonly caps: DriverCaps = {
    planFeedbackReopens: true, // via the stop_hook_active re-review path
    turnEndReview: "blocking",
    afterApprove: "tui-select",
  };

  private readonly tmux = new TmuxSession();
  private home?: HarnessHome;
  private ctx?: DriverContext;

  isAvailable(): Promise<boolean | string> {
    if (!tmuxAvailable()) {
      return Promise.resolve("tmux not on PATH");
    }
    return Promise.resolve(probeCodex());
  }

  launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    this.home = buildCodexHome();
    // Canonicalize the temp CODEX_HOME: Codex trusts hooks by their canonical hooks.json path, so the
    // trust-key path we compute must match what Codex resolves (os.tmpdir() is a /var symlink on mac).
    const codexHome = fs.realpathSync(this.home.env.CODEX_HOME as string);
    this.home.env.CODEX_HOME = codexHome;
    this.writeCodexConfig(codexHome, ctx.repoRoot);

    const env = { ...baseHarnessEnv(), ...this.home.env };
    const command = `codex --cd ${shellQuote(fs.realpathSync(ctx.repoRoot))}`;
    this.log(`launch: ${command} (CODEX_HOME=${codexHome})`);
    this.tmux.launch({ cwd: ctx.repoRoot, env, command });
    return Promise.resolve();
  }

  async enterPlanMode(): Promise<void> {
    await delay(4000); // let the TUI fully boot before the first key registers
    // Shift-Tab TOGGLES Default↔Plan. A keystroke sent before the TUI is interactive is silently
    // lost, so re-send until the footer confirms "Plan mode" — checking BEFORE each send so a
    // registered toggle is never undone by an extra press. (codex-cli 0.144.4: footer shows
    // "Plan mode (shift+tab to cycle)".)
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (PLAN_MODE.test(this.tmux.capture())) {
        this.log("enterPlanMode: plan mode confirmed");
        return;
      }
      this.tmux.sendKeys("BTab");
      await delay(1500); // let the footer settle before re-checking
    }
    this.log("enterPlanMode: 'plan mode' not seen in footer within 30s (continuing anyway)");
  }

  async prompt(text: string): Promise<void> {
    this.log(`prompt: ${text}`);
    await this.tmux.typeLine(text);
  }

  async afterPlanApprove(): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (IMPLEMENT_SELECTOR.test(this.tmux.capture())) {
        this.log('afterPlanApprove: "Implement this plan?" selector shown — Enter (option 1)');
        this.tmux.sendKeys("Enter");
        return;
      }
      await delay(1000);
    }
    this.log("afterPlanApprove: implement selector not seen within 90s (test will dump)");
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

  /** Build hooks.json + config.toml in the temp home via the real installer pure functions, then add
   *  the trusted-project entry so implementation never stalls on an approval prompt. */
  private writeCodexConfig(codexHome: string, sandboxRepo: string): void {
    const scriptsDir = path.join(repoRoot(), "plugins", "codex", "scripts");
    const template = fs.readFileSync(
      path.join(repoRoot(), "plugins", "codex", "hooks.json"),
      "utf8",
    );
    const resolved = resolveCodexGroups(template, scriptsDir);
    // Record mode: rewrite each command to run under the hook shim (which spawns the REAL script). The
    // trust hashes below are then computed over the EXACT shim command strings, so Codex trusts them.
    const groups = this.wireRecordShims(resolved);
    const hooksPath = path.join(codexHome, "hooks.json");
    // Fresh home → empty source; marker is the scripts dir (identifies OUR groups on a re-merge).
    const { text: hooksText, placements } = mergeCodexHooks("", groups, scriptsDir);
    fs.writeFileSync(hooksPath, hooksText, "utf8");

    const entries = codexTrustEntries(hooksPath, placements);
    const trusted = appendCodexTrust("", entries);
    const { text: withFeatures } = ensureCodexFeaturesHooks(trusted);
    const project = fs.realpathSync(sandboxRepo);
    const config = `${withFeatures}\n[projects.${tomlKey(project)}]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(path.join(codexHome, "config.toml"), config, "utf8");
    this.log(`wrote hooks.json (${placements.length} groups) + config.toml (project trusted)`);
  }

  /** In record mode, rewrite every hook command to `node <shim> <repo-relative-script>` so the shim
   *  spawns the REAL script; a no-op otherwise. The command strings are hashed verbatim into the trust
   *  keys, so Codex trusts the shim commands exactly. */
  private wireRecordShims(
    groups: ReturnType<typeof resolveCodexGroups>,
  ): ReturnType<typeof resolveCodexGroups> {
    const rc = getRecordContext();
    if (!rc) {
      return groups;
    }
    return groups.map((group) => ({
      ...group,
      hooks: group.hooks.map((handler) => ({
        ...handler,
        command: recordCommand(handler.command, rc.hookShim, rc.repoRoot),
      })),
    }));
  }

  private log(line: string): void {
    this.ctx?.log.push(`${new Date().toISOString()} [codex] ${line}`);
  }
}

/** The extension repo root (where the shipped plugins/ live). */
function repoRoot(): string {
  return process.env.PAIRETO_REPO_ROOT ?? path.resolve(__dirname, "..", "..", "..");
}

/** Rewrite a resolved `node "<absScript>"` command to run under the record hook shim. Leaves an
 *  unexpected command shape untouched (fail-safe). */
function recordCommand(command: string, hookShim: string, repoRoot: string): string {
  const m = /^node "(.+)"$/.exec(command);
  if (!m) {
    return command;
  }
  return shimHookCommand(m[1], { hookShim, repoRoot });
}

/** TOML basic (double-quoted) key — escape `\` and `"` so any path stays valid TOML. */
function tomlKey(key: string): string {
  return `"${key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function shellQuote(p: string): string {
  return `"${p.replace(/(["$`\\])/g, "\\$1")}"`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
