// Real OpenCode driver. A long-lived `opencode serve` process hosts the bundled plugin, and one
// `opencode run --attach` turn drives the whole plan→implement→review cascade. The post-hoc stop-gate
// round-trip only works under a persistent server — a bare `opencode run` exits at session.idle
// before the gate can round-trip. No tmux: these are plain child processes.
//
// Record/check use a hermetic empty config plus our bundled plugin via the real openCodeInstallPlan.
// OpenCode's built-in OpenAI OAuth provider reads auth.json
// from XDG_DATA_HOME and exposes the Codex-subscription models without third-party plugins.
//
// A run that exits without writing its case's completion marker never carried the flow through (in
// the full-flow case, a plan-tool miss: the model answered as plain text instead of calling
// paireto_submit_plan). That is a test failure: silently retrying a fresh session would not match
// what happens to a user and could hide an unreliable integration.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openCodeInstallPlan } from "../../bridge/OpenCodeInstaller.js";
import { resolveMode, type E2EMode } from "../mockserver/mode.js";
import { resolveMockProxy } from "../mockserver/proxyEnv.js";
import { buildOpenCodeHome, mockPath, probeOpenCode, type HarnessHome } from "../sandbox.js";
import { baseHarnessEnv } from "./harnessEnv.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "./types.js";
import { watchChildOutput } from "./watch.js";

// A fast, affordable model supported by ChatGPT-account Codex OAuth.
const MODEL = "openai/gpt-5.6-luna";
const PLAN_AGENT = "plan";
/** The full-flow case's own marker: the first file its implement step writes, so its presence means
 *  the run engaged the plan gate and got past approve rather than missing the plan tool. */
const IMPLEMENT_MARKER = "hello.txt";
/** Resolved lazily so importing the driver does not touch the filesystem. */
const mockHomeDir = (): string => mockPath("pai-e2e-opencode-home");

/**
 * A line of `opencode run` output that means the flow can no longer complete, or undefined for
 * ordinary progress. The agent blocks on a denied tool call and never retries, so the run would
 * otherwise sit until the step budget expires with the reason buried in its log.
 */
export function openCodeRunFatal(line: string): string | undefined {
  const rejected = /permission requested: (\S+)[^\n]*auto-rejecting/i.exec(line);
  if (rejected) {
    return (
      `OpenCode auto-rejected a permission request (${rejected[1]}), so the agent stopped acting on ` +
      "the workspace. Whatever it asked for is outside the sandbox it was given."
    );
  }
  return /the user rejected permission to use this specific tool call/i.test(line)
    ? "OpenCode reported a rejected tool call, so the agent stopped acting on the workspace"
    : undefined;
}

/**
 * The `opencode run` argument list for one turn. The plan agent denies every edit until a plan
 * approval releases it, so it is passed only for a case that proposes a plan: a case that never does
 * would sit in that agent for its whole run and could not act on any feedback it was sent.
 */
export function openCodeRunArgs(turn: {
  serverUrl: string;
  repoRoot: string;
  prompt: string;
  planMode: boolean;
}): string[] {
  return [
    "run",
    "--attach",
    turn.serverUrl,
    "--dir",
    turn.repoRoot,
    ...(turn.planMode ? ["--agent", PLAN_AGENT] : []),
    "--model",
    MODEL,
    turn.prompt,
  ];
}

export class OpenCodeDriver implements HarnessDriver {
  readonly harness = "opencode";
  readonly caps: DriverCaps = {
    turnEndReview: "post-hoc", // session.idle is fire-and-forget; the agent is already idle
    guidedReviewInvocation: "/paireto-guided-review",
    reviewInvocation: "/paireto-review",
    reportsTurnEndAfterPlan: true,
  };

  private home?: HarnessHome;
  private ctx?: DriverContext;
  private env?: NodeJS.ProcessEnv;
  private mode: E2EMode = "record";
  private serve?: ChildProcess;
  private run?: ChildProcess;
  private serverUrl?: string;
  private promptText?: string;
  private runStartedAt = 0;
  private serveLog: string[] = [];
  private runLog: string[] = [];
  /** Set when the run can no longer complete; the test polls fatalError() and aborts. */
  private fatal?: string;

  isAvailable(): Promise<boolean | string> {
    return Promise.resolve(probeOpenCode(resolveMode(process.env)));
  }

  async launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    this.mode = resolveMode(process.env);
    const proxy = resolveMockProxy();
    this.home = buildOpenCodeHome({
      checkMode: this.mode === "check",
      homeDir: mockHomeDir(),
    });
    this.env = { ...baseHarnessEnv(), ...this.home.env };
    // localhost serve/attach stays direct through NO_PROXY; provider traffic is recorded or replayed.
    Object.assign(this.env, proxy.env);
    this.log(`mode=${this.mode}: HTTPS_PROXY=${proxy.url} (+CA trust)`);
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

  fatalError(): string | undefined {
    return this.fatal;
  }

  screen(): Promise<string> {
    const wire = (this.ctx?.log ?? []).join("\n");
    const providerLog = this.readProviderLog();
    const fatal = this.fatal ? `--- driver fatal ---\n${this.fatal}\n` : "";
    return Promise.resolve(
      fatal +
        `${wire}\n--- opencode serve log ---\n${this.serveLog.join("\n")}\n--- opencode run log ---\n${this.runLog.join("\n")}\n--- opencode provider log ---\n${providerLog}`,
    );
  }

  dispose(): Promise<void> {
    kill(this.run);
    kill(this.serve);
    this.home?.cleanup();
    return Promise.resolve();
  }

  // --- config staging -----------------------------------------------------------------------------

  /** Start empty so replay never installs a network plugin, then install the bundled Paireto plugin. */
  private stageConfig(): void {
    const configDir = path.join(this.home!.env.XDG_CONFIG_HOME as string, "opencode");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "opencode.json"), "{}\n");
    this.stagePluginSdk(configDir);
    // Install our plugin (paireto.js + adapter.json + the review command) into the temp config dir.
    for (const copy of openCodeInstallPlan(path.join(repoRoot(), "dist", "plugins"), configDir)) {
      fs.mkdirSync(path.dirname(copy.to), { recursive: true });
      fs.copyFileSync(copy.from, copy.to);
    }
    this.log(`staged config at ${configDir}`);
  }

  /**
   * Pre-stage `@opencode-ai/plugin` so mock-mode runs resolve it offline.
   *
   * OpenCode npm-installs the plugin SDK into its config dir at runtime, which a credential-free
   * `check` run cannot do. Without the SDK our plugin's `planToolArgs()` falls back to an empty
   * schema, advertising paireto_submit_plan with no `plan` parameter, and the model can never submit
   * a plan. Staging it keeps record on the same plugin surface as check.
   */
  private stagePluginSdk(configDir: string): void {
    const source = pluginSdkSource();
    if (!source) {
      // Loud, because the symptom downstream is only a plan-gate timeout.
      this.log(
        "WARNING: no OpenCode plugin SDK to stage (set PAIRETO_OPENCODE_SDK, or install opencode " +
          "locally) — OpenCode will try to npm-install it, which fails offline and leaves " +
          "paireto_submit_plan without its `plan` parameter",
      );
      return;
    }
    fs.cpSync(source, path.join(configDir, "node_modules"), { recursive: true });
    this.log(`staged OpenCode plugin SDK from ${source}`);
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
      watchChildOutput(this.harness, redactSecrets(text));
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

  /** Spawn one `opencode run --attach` turn. It drives the whole cascade while gates round-trip via
   *  the socket. A plan-tool miss remains visible and the E2E fails, just as the user's run would. */
  private spawnRun(): void {
    const args = openCodeRunArgs({
      serverUrl: this.serverUrl!,
      repoRoot: this.ctx!.repoRoot,
      prompt: this.promptText!,
      planMode: this.ctx?.planMode !== false,
    });
    this.log(`run: opencode ${args.join(" ")}`);
    this.runStartedAt = Date.now();
    this.run = spawn("opencode", args, {
      cwd: this.ctx!.repoRoot,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onData = (chunk: Buffer): void => {
      const text = redactSecrets(chunk.toString());
      this.runLog.push(text.trimEnd());
      watchChildOutput(this.harness, text);
      for (const line of text.split("\n")) {
        const fatal = openCodeRunFatal(line);
        if (fatal) {
          this.fatal ??= `${fatal}\n  ${line.trim()}`;
          this.log(`FATAL: ${fatal}`);
        }
      }
    };
    this.run.stdout?.on("data", onData);
    this.run.stderr?.on("data", onData);
    this.run.on("exit", (code) => {
      const elapsed = Date.now() - this.runStartedAt;
      this.log(`run exited code=${code} after ${elapsed}ms`);
      const marker = this.ctx?.completionMarker ?? IMPLEMENT_MARKER;
      if (!fs.existsSync(path.join(this.ctx!.repoRoot, marker))) {
        this.fatal ??=
          `opencode run exited (code=${code}) without writing ${marker} — its turn ended before it ` +
          "carried the flow through, so no later step can complete. The assistant's actual reply is " +
          "in the run log below.";
        this.log(
          `run exited (code=${code}) without writing ${marker}: the agent's turn ended before the ` +
            "flow completed. This is a real integration failure — the test fails rather than " +
            "retrying, because a user's run would fail the same way. Check the run/provider logs " +
            "below for the assistant's actual reply.",
        );
      }
    });
  }

  private log(line: string): void {
    this.ctx?.log.push(`${new Date().toISOString()} [opencode] ${line}`);
  }

  private readProviderLog(): string {
    const dataHome = this.home?.env.XDG_DATA_HOME;
    if (!dataHome) {
      return "";
    }
    try {
      const value = fs.readFileSync(path.join(dataHome, "opencode", "log", "opencode.log"), "utf8");
      return redactSecrets(value).split("\n").slice(-200).join("\n");
    } catch {
      return "";
    }
  }
}

/**
 * A `node_modules` holding `@opencode-ai/plugin`, for mock runs to resolve offline. The Docker image
 * pre-installs one at PAIRETO_OPENCODE_SDK; natively the user's own opencode config already has it,
 * from OpenCode's own runtime install.
 */
function pluginSdkSource(): string | undefined {
  const candidates = [
    process.env.PAIRETO_OPENCODE_SDK
      ? path.join(process.env.PAIRETO_OPENCODE_SDK, "node_modules")
      : undefined,
    path.join(realOpenCodeConfigDir(), "node_modules"),
  ];
  return candidates.find(
    (dir) => dir !== undefined && fs.existsSync(path.join(dir, "@opencode-ai", "plugin")),
  );
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

function redactSecrets(value: string): string {
  return value
    .replace(/bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<redacted-jwt>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "<redacted-token>");
}
