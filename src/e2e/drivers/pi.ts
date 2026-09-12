// Real Pi driver. One long-lived `pi --mode rpc` process hosts the bundled Pi package and takes each
// turn as a JSON line on stdin. RPC rather than the TUI for the same reason OpenCode uses
// `serve` + `run`: the post-hoc turn-end gate needs a process that outlives the turn, and the flow
// here is driven entirely by the socket rather than by keystrokes.
//
// Pi reaches the ChatGPT backend through its own `openai-codex` provider, so record consumes the same
// subscription the Codex driver does — `buildPiHome` restates the machine's Codex token in Pi's
// credential shape. Startup network chatter (version + package update checks) is switched off with
// PI_OFFLINE so only inference reaches the recorder.
//
// A run that exits without writing its case's completion marker never carried the flow through. That
// is a test failure, not something to retry: a user's run would fail the same way.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { installPi } from "../../bridge/PiInstaller.js";
import { resolveMode, type E2EMode } from "../mockserver/mode.js";
import { resolveMockProxy } from "../mockserver/proxyEnv.js";
import { buildPiHome, mockPath, probePi, type HarnessHome } from "../sandbox.js";
import { baseHarnessEnv } from "./harnessEnv.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "./types.js";
import { watchChildOutput } from "./watch.js";

/** A fast, affordable model supported by ChatGPT-account Codex OAuth — the one the other
 *  subscription drivers pin. */
const MODEL = "openai-codex/gpt-5.6-luna";
/** The command the bundled package registers to arm Paireto plan mode for the turn it starts. */
const PLAN_COMMAND = "/paireto-plan";
/** The full-flow case's own marker: the first file its implement step writes. */
const IMPLEMENT_MARKER = "hello.txt";
/** Resolved lazily so importing the driver does not touch the filesystem. */
const mockHomeDir = (): string => mockPath("pai-e2e-pi-home");

/** Token-by-token stream events. Kept out of the failure log: they are the bulk of the RPC output and
 *  say nothing a failure needs, and a dump too large for the test reporter is printed as nothing. */
const NOISY_RPC_EVENTS = new Set(["message_update", "bash_execution_update"]);
/** How much of the RPC log a failure dump carries. */
const RPC_LOG_LINES = 400;
/** A single line's ceiling in that dump — one message event can hold a whole file. */
const RPC_LINE_CHARS = 2_000;

/** Whether an RPC line belongs in the failure log. */
export function keepRpcLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    return typeof parsed.type !== "string" || !NOISY_RPC_EVENTS.has(parsed.type);
  } catch {
    return true;
  }
}

/** Pi settings the run needs beyond the package the installer registers. */
export const PI_SETTINGS: Record<string, unknown> = {
  // Non-interactive modes never prompt for project trust; without this they would silently ignore
  // project resources, which is not the shape a user's trusted repo has.
  defaultProjectTrust: "always",
  enableSkillCommands: true,
  // Pi's ChatGPT transport defaults to WebSocket, which no HTTP proxy can record or replay. Codex is
  // pinned the same way for the same reason; SSE is the one transport a cassette can hold.
  transport: "sse",
};

/** The `pi --mode rpc` argument list for the session. */
export function piRunArgs(): string[] {
  return ["--mode", "rpc", "--model", MODEL];
}

/** The line a case's prompt becomes: plan mode rides on the package's own command. */
export function piPromptLine(text: string, planMode: boolean): string {
  return planMode ? `${PLAN_COMMAND} ${text}` : text;
}

/**
 * A reason an RPC line means the flow can no longer complete, or undefined for ordinary progress. A
 * rejected prompt never starts a turn, so the run would otherwise sit until the step budget expires.
 */
export function piRpcFatal(line: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const message = parsed as { type?: unknown; success?: unknown; error?: unknown };
  if (message.type === "response" && message.success === false) {
    return `Pi rejected an RPC command: ${typeof message.error === "string" ? message.error : line}`;
  }
  return undefined;
}

export class PiDriver implements HarnessDriver {
  readonly harness = "pi";
  readonly caps: DriverCaps = {
    turnEndReview: "post-hoc", // agent_settled fires once the agent is already idle
    guidedReviewInvocation: "/skill:paireto-guided-review",
    reviewInvocation: "/skill:paireto-review",
    opensTurnEndReview: true,
  };

  private home?: HarnessHome;
  private ctx?: DriverContext;
  private env?: NodeJS.ProcessEnv;
  private mode: E2EMode = "record";
  private rpc?: ChildProcess;
  private rpcLog: string[] = [];
  private stdoutTail = "";
  private requestId = 0;
  private fatal?: string;

  isAvailable(): Promise<boolean | string> {
    return Promise.resolve(probePi(resolveMode(process.env)));
  }

  async launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    this.mode = resolveMode(process.env);
    const proxy = resolveMockProxy();
    this.home = buildPiHome({ checkMode: this.mode === "check", homeDir: mockHomeDir() });
    this.env = {
      ...baseHarnessEnv(),
      ...this.home.env,
      ...proxy.env,
      // No update or package checks — only inference should reach the recorder.
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    this.log(`mode=${this.mode}: HTTPS_PROXY=${proxy.url} (+CA trust)`);
    await this.stageSettings();
    this.spawnRpc();
  }

  enterPlanMode(): Promise<void> {
    return Promise.resolve(); // the plan command rides on the first prompt
  }

  prompt(text: string): Promise<void> {
    const message = piPromptLine(text, this.ctx?.planMode !== false);
    this.requestId += 1;
    this.send({ id: `pai-${this.requestId}`, type: "prompt", message });
    return Promise.resolve();
  }

  fatalError(): string | undefined {
    return this.fatal;
  }

  screen(): Promise<string> {
    const wire = (this.ctx?.log ?? []).join("\n");
    const fatal = this.fatal ? `--- driver fatal ---\n${this.fatal}\n` : "";
    const rpc = this.rpcLog.slice(-RPC_LOG_LINES).join("\n");
    return Promise.resolve(`${fatal}${wire}\n--- pi rpc log (tail) ---\n${rpc}`);
  }

  dispose(): Promise<void> {
    if (this.rpc && this.rpc.exitCode === null) {
      try {
        this.rpc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    this.home?.cleanup();
    return Promise.resolve();
  }

  // --- config staging ---------------------------------------------------------------------------

  /** Seed the run's settings, then install the bundled package through the real installer, so the
   *  E2E exercises the same registration a user's setup performs. */
  private async stageSettings(): Promise<void> {
    const agentDir = this.home!.env.PI_CODING_AGENT_DIR as string;
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify(PI_SETTINGS, null, 2)}\n`,
    );
    const stableDir = path.join(path.dirname(agentDir), "adapters", "pi");
    fs.mkdirSync(stableDir, { recursive: true });
    const result = await installPi(
      { pluginsRoot: path.join(repoRoot(), "dist", "plugins"), stableDir },
      { agentDir },
    );
    if (!result.ok) {
      throw new Error(result.detail);
    }
    this.log(`staged pi home at ${agentDir}`);
  }

  // --- rpc session ------------------------------------------------------------------------------

  private spawnRpc(): void {
    const args = piRunArgs();
    this.log(`run: pi ${args.join(" ")}`);
    this.rpc = spawn("pi", args, {
      cwd: this.ctx!.repoRoot,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.rpc.stdout?.on("data", (chunk: Buffer) => this.readStdout(chunk.toString()));
    this.rpc.stderr?.on("data", (chunk: Buffer) => {
      const text = redactSecrets(chunk.toString());
      this.rpcLog.push(text.trimEnd());
      watchChildOutput(this.harness, text);
    });
    this.rpc.on("exit", (code) => {
      this.log(`rpc exited code=${code}`);
      const marker = this.ctx?.completionMarker ?? IMPLEMENT_MARKER;
      if (!fs.existsSync(path.join(this.ctx!.repoRoot, marker))) {
        this.fatal ??=
          `pi --mode rpc exited (code=${code}) without writing ${marker} — the session ended before ` +
          "it carried the flow through, so no later step can complete. The RPC log below holds the " +
          "assistant's actual reply.";
      }
    });
  }

  /** RPC framing is strict JSONL on LF only, so the tail of a chunk is held until its newline. */
  private readStdout(chunk: string): void {
    this.stdoutTail += chunk;
    const lines = this.stdoutTail.split("\n");
    this.stdoutTail = lines.pop() ?? "";
    for (const raw of lines) {
      const line = redactSecrets(raw.replace(/\r$/, ""));
      if (line.trim() === "") {
        continue;
      }
      if (keepRpcLine(line)) {
        this.rpcLog.push(line.slice(0, RPC_LINE_CHARS));
        if (this.rpcLog.length > RPC_LOG_LINES * 2) {
          this.rpcLog = this.rpcLog.slice(-RPC_LOG_LINES);
        }
      }
      watchChildOutput(this.harness, line.slice(0, 300));
      const fatal = piRpcFatal(line);
      if (fatal) {
        this.fatal ??= fatal;
        this.log(`FATAL: ${fatal}`);
      }
    }
  }

  private send(command: Record<string, unknown>): void {
    this.log(`send: ${JSON.stringify(command).slice(0, 200)}`);
    this.rpc?.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  private log(line: string): void {
    this.ctx?.log.push(`${new Date().toISOString()} [pi] ${line}`);
  }
}

/** The extension repo root (where the shipped plugins/ live). */
function repoRoot(): string {
  return process.env.PAIRETO_REPO_ROOT ?? path.resolve(__dirname, "..", "..", "..");
}

function redactSecrets(value: string): string {
  return value
    .replace(/bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<redacted-jwt>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "<redacted-token>");
}
