// Real OpenCode driver. A long-lived `opencode serve` process hosts the bundled plugin, and one
// `opencode run --attach` turn drives the whole plan→implement→review cascade. The post-hoc stop-gate
// round-trip only works under a persistent server — a bare `opencode run` exits at session.idle
// before the gate can round-trip. No tmux: these are plain child processes.
//
// The temp XDG_CONFIG_HOME/opencode is staged from the user's real config (opencode.json + the
// opencodex auth plugin + its node_modules, which surface the Codex-subscription OpenAI models) plus
// our bundled plugin via the real openCodeInstallPlan; auth.json is copied into XDG_DATA_HOME.
//
// A run that exits WITHOUT writing any files is a plan-tool miss (the model answered as plain text
// instead of calling paireto_submit_plan); a successful run also exits fast, so the filesystem — not
// timing — is the discriminator, and the driver retries ONCE in a fresh session on a miss.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openCodeInstallPlan } from "../../bridge/OpenCodeInstaller.js";
import { buildOpenCodeHome, probeOpenCode, type HarnessHome } from "../sandbox.js";
import { baseHarnessEnv } from "./harnessEnv.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "./types.js";

// A cheap, fast Codex-subscription model via the opencodex plugin (opencode's default resolves here).
const MODEL = "openai/gpt-5.5-fast";
const PLAN_AGENT = "plan";
/** The first file the implement step writes — its presence means the run engaged the plan gate and
 *  got past approve, so an exit is normal completion, NOT a plan-tool miss to retry. */
const IMPLEMENT_MARKER = "hello.txt";

export class OpenCodeDriver implements HarnessDriver {
  readonly harness = "opencode";
  readonly caps: DriverCaps = {
    planFeedbackReopens: true,
    turnEndReview: "post-hoc", // session.idle is fire-and-forget; the agent is already idle
    afterApprove: "agent-switch", // approve → nextMode:build switches the agent in-process
  };

  private home?: HarnessHome;
  private ctx?: DriverContext;
  private env?: NodeJS.ProcessEnv;
  private serve?: ChildProcess;
  private run?: ChildProcess;
  private serverUrl?: string;
  private promptText?: string;
  private runStartedAt = 0;
  private retried = false;
  private serveLog: string[] = [];

  isAvailable(): Promise<boolean | string> {
    return Promise.resolve(probeOpenCode());
  }

  async launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    this.home = buildOpenCodeHome();
    this.env = { ...baseHarnessEnv(), ...this.home.env };
    this.stageConfig();
    await this.startServer();
  }

  enterPlanMode(): Promise<void> {
    return Promise.resolve(); // --agent plan is passed to `opencode run`
  }

  prompt(text: string): Promise<void> {
    this.promptText = text;
    this.spawnRun();
    return Promise.resolve();
  }

  afterPlanApprove(): Promise<void> {
    return Promise.resolve(); // agent-switch is automatic (nextMode:build); no keystroke needed
  }

  screen(): Promise<string> {
    const wire = (this.ctx?.log ?? []).join("\n");
    return Promise.resolve(`${wire}\n--- opencode serve log ---\n${this.serveLog.join("\n")}`);
  }

  dispose(): Promise<void> {
    kill(this.run);
    kill(this.serve);
    this.home?.cleanup();
    return Promise.resolve();
  }

  // --- config staging -----------------------------------------------------------------------------

  /** Copy the user's real opencode config (opencodex auth plugin + its deps) into the temp config,
   *  then install the bundled Paireto plugin via the real install plan. Never writes the real config. */
  private stageConfig(): void {
    const configDir = path.join(this.home!.env.XDG_CONFIG_HOME as string, "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    const realConfig = realOpenCodeConfigDir();
    // These carry the opencodex provider the driver's model depends on.
    for (const name of [
      "opencode.json",
      "opencodex-fast.jsonc",
      "package.json",
      "package-lock.json",
      "bun.lock",
      "node_modules",
    ]) {
      const src = path.join(realConfig, name);
      if (fs.existsSync(src)) {
        fs.cpSync(src, path.join(configDir, name), { recursive: true });
      }
    }
    // Install our plugin (paireto.js + adapter.json + the review command) into the temp config dir.
    for (const copy of openCodeInstallPlan(path.join(repoRoot(), "plugins"), configDir)) {
      fs.mkdirSync(path.dirname(copy.to), { recursive: true });
      fs.copyFileSync(copy.from, copy.to);
    }
    this.log(`staged config at ${configDir}`);
  }

  // --- server + run -------------------------------------------------------------------------------

  private async startServer(): Promise<void> {
    this.serve = spawn("opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      cwd: this.ctx!.repoRoot,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString();
      this.serveLog.push(text.trimEnd());
      const match = /listening on (http:\/\/[\d.]+:\d+)/i.exec(text);
      if (match && !this.serverUrl) {
        this.serverUrl = match[1];
      }
    };
    this.serve.stdout?.on("data", onData);
    this.serve.stderr?.on("data", onData);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.serverUrl) {
        this.log(`serve listening at ${this.serverUrl}`);
        return;
      }
      if (this.serve.exitCode !== null) {
        throw new Error(`opencode serve exited early (code ${this.serve.exitCode})`);
      }
      await delay(300);
    }
    throw new Error("opencode serve did not report a listening URL within 30s");
  }

  /** Spawn one `opencode run --attach` turn. It drives the whole cascade; gates round-trip via the
   *  socket while it streams. On an early exit (plan-tool miss) it retries once in a fresh session. */
  private spawnRun(): void {
    const args = [
      "run",
      "--attach",
      this.serverUrl!,
      "--dir",
      this.ctx!.repoRoot,
      "--agent",
      PLAN_AGENT,
      "--model",
      MODEL,
      this.promptText!,
    ];
    this.log(`run: opencode ${args.join(" ")}`);
    this.runStartedAt = Date.now();
    this.run = spawn("opencode", args, { cwd: this.ctx!.repoRoot, env: this.env, stdio: "ignore" });
    this.run.on("exit", (code) => {
      const elapsed = Date.now() - this.runStartedAt;
      this.log(`run exited code=${code} after ${elapsed}ms`);
      // A successful run also exits fast (the persistent serve keeps the session + fires post-hoc
      // gates), so retry ONLY when the implement marker never appeared — that uniquely identifies a
      // plan-tool miss vs. a normal completion.
      const engaged = fs.existsSync(path.join(this.ctx!.repoRoot, IMPLEMENT_MARKER));
      if (!engaged && !this.retried) {
        this.retried = true;
        this.log(
          "run exited without writing files (plan-tool miss) — retrying once in a fresh session",
        );
        this.spawnRun();
      }
    });
  }

  private log(line: string): void {
    this.ctx?.log.push(`${new Date().toISOString()} [opencode] ${line}`);
  }
}

/** The user's real opencode config dir (READ-only source for the free-model plugin). */
function realOpenCodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opencode");
}

/** The extension repo root (where the shipped plugins/ live). */
function repoRoot(): string {
  return process.env.PAIRETO_REPO_ROOT ?? path.resolve(__dirname, "..", "..", "..");
}

function kill(child: ChildProcess | undefined): void {
  if (child && child.exitCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
