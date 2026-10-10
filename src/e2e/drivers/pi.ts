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

const MODEL = "openai-codex/gpt-5.6-luna";
const PLAN_COMMAND = "/crafty-plan";
const IMPLEMENT_MARKER = "hello.txt";
const mockHomeDir = (): string => mockPath("pai-e2e-pi-home");

const NOISY_RPC_EVENTS = new Set(["message_update", "bash_execution_update"]);
const RPC_LOG_LINES = 400;
const RPC_LINE_CHARS = 2_000;

export function keepRpcLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    return typeof parsed.type !== "string" || !NOISY_RPC_EVENTS.has(parsed.type);
  } catch {
    return true;
  }
}

export const PI_SETTINGS: Record<string, unknown> = {
  defaultProjectTrust: "always",
  enableSkillCommands: true,
  transport: "sse",
};

export function piRunArgs(): string[] {
  return ["--mode", "rpc", "--model", MODEL];
}

export function piPromptLine(text: string, planMode: boolean): string {
  return planMode ? `${PLAN_COMMAND} ${text}` : text;
}

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
    turnEndReview: "post-hoc",
    guidedReviewInvocation: "/skill:crafty-guided-review",
    reviewInvocation: "/skill:crafty-review",
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
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
    };
    this.log(`mode=${this.mode}: HTTPS_PROXY=${proxy.url} (+CA trust)`);
    await this.stageSettings();
    this.spawnRpc();
  }

  enterPlanMode(): Promise<void> {
    return Promise.resolve();
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
      } catch {}
    }
    this.home?.cleanup();
    return Promise.resolve();
  }

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

function repoRoot(): string {
  return process.env.CRAFTY_REPO_ROOT ?? path.resolve(__dirname, "..", "..", "..");
}

function redactSecrets(value: string): string {
  return value
    .replace(/bearer\s+[^\s"']+/gi, "Bearer <redacted>")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "<redacted-jwt>")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "<redacted-token>");
}
