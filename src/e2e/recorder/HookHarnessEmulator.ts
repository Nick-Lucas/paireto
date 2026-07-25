// Replay emulator for the claude + codex harnesses: a strict sequential executor over a tape
// that RE-DRIVES the real repo hook scripts against the REAL extension, emulating only the harness.
//
//   hook.start → materialize any {{FILE:n}} aux files, denormalize env/stdin/cwd (current XDG_STATE_HOME
//                so the real bridge.js dials the REAL socket), spawn `node <repo>/plugins/<script>` with
//                stdin written, capture stdout — do NOT await (a blocking gate hook stays inflight).
//   hook.end   → await that invocation's exit, compare normalized stdout + exit code to the tape.
//   proc.start → spawn the real MCP liveness server, stdin held open (never written).
//   proc.stop  → kill it + await exit.
//
// The blocking gate hook's `hook.end` parks the loop exactly where the harness parked; the test body's
// driveUntil loop fires paireto.gate.* against the extension, whose response unblocks the real script.

import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  compareMessages,
  denormalizeMessage,
  normalizeMessage,
  renderDivergence,
} from "./normalize.js";
import { TapeExecutor } from "./TapeExecutor.js";
import type { HookEndEvent, HookStartEvent, ProcStartEvent, TapeEvent } from "./tapeTypes.js";

/** Resolved exit of one spawned hook invocation. */
interface HookResult {
  stdout: string;
  exit: number;
}

export class HookHarnessEmulator extends TapeExecutor {
  private readonly repoRootAbs = requireEnv("PAIRETO_REPO_ROOT");
  private readonly nodeBin = resolveNodeBin();
  /** Temp dir the materialized {{FILE:n}} aux files live in. */
  private readonly fileDir = fs.mkdtempSync(`${os.tmpdir()}/pai-replay-files-`);
  /** Inflight/finished hook invocations by `inv` → a promise of its exit. */
  private readonly hooks = new Map<number, Promise<HookResult>>();
  private readonly children = new Set<cp.ChildProcess>();
  /** Long-lived processes (MCP liveness) by `proc`. */
  private readonly procs = new Map<number, cp.ChildProcess>();

  protected async step(event: TapeEvent): Promise<void> {
    switch (event.k) {
      case "hook.start":
        this.startHook(event);
        return;
      case "hook.end":
        await this.endHook(event);
        return;
      case "proc.start":
        this.startProc(event);
        return;
      case "proc.stop":
        await this.stopProc(event.proc);
        return;
      default:
        // client.call / plugin.* never appear in a claude/codex tape — ignore defensively.
        return;
    }
  }

  protected drainCheck(): string | undefined {
    // Completeness (unconsumed tape) is asserted by the base; nothing socket-queue-like to check here.
    return undefined;
  }

  protected teardown(): void {
    for (const child of [...this.procs.values(), ...this.children]) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* best effort */
      }
    }
    this.procs.clear();
    this.children.clear();
    try {
      fs.rmSync(this.fileDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  protected status(): string {
    const inflight = [...this.hooks.keys()];
    return inflight.length > 0 ? `hooks inflight: ${inflight.join(",")}` : "";
  }

  // --- hooks -------------------------------------------------------------------------------------

  /** Spawn the real hook script (stdin written, stdout captured); store its exit promise. */
  private startHook(event: HookStartEvent): void {
    this.blockedOn = `hook start inv ${event.inv} ${event.script}`;
    const scriptAbs = path.join(this.repoRootAbs, event.script);
    const cwd = this.denormStr(event.cwd);
    const env = this.childEnv(event.env);
    const stdin = this.materializeStdin(event);

    const child = cp.spawn(this.nodeBin, [scriptAbs], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.children.add(child);
    const result = new Promise<HookResult>((resolve) => {
      const out: Buffer[] = [];
      child.stdout?.on("data", (c: Buffer) => out.push(Buffer.from(c)));
      child.on("error", () => resolve({ stdout: Buffer.concat(out).toString("utf8"), exit: 1 }));
      child.on("close", (code) => {
        this.children.delete(child);
        resolve({ stdout: Buffer.concat(out).toString("utf8"), exit: code ?? 1 });
      });
    });
    this.hooks.set(event.inv, result);
    child.stdin?.write(stdin);
    child.stdin?.end();
  }

  /** Await the invocation's exit, then compare normalized stdout + exit code; apply its fs delta. */
  private async endHook(event: HookEndEvent): Promise<void> {
    const pending = this.hooks.get(event.inv);
    if (!pending) {
      this.fail(`hook.end for inv ${event.inv} but no matching hook.start (seq ${event.seq})`);
      return;
    }
    this.blockedOn = `hook end inv ${event.inv}`;
    const actual = await pending;
    if (this.failure) {
      return;
    }
    const diff = this.compareStdout(event.stdout, actual.stdout);
    if (diff) {
      this.fail(`inv ${event.inv} (seq ${event.seq}) stdout diverged:\n${diff}`);
      return;
    }
    if (actual.exit !== event.exit) {
      this.fail(
        `inv ${event.inv} (seq ${event.seq}) exit code: tape ${event.exit}, got ${actual.exit}`,
      );
      return;
    }
    if (event.fs) {
      this.applyFs(event.fs);
    }
  }

  // --- long-lived processes ----------------------------------------------------------------------

  /** Spawn the real MCP liveness server: stdin held open (never written) so it doesn't exit; its
   *  socket to the extension is the liveness connection, dropped on kill at proc.stop. */
  private startProc(event: ProcStartEvent): void {
    this.blockedOn = `proc start ${event.proc} ${event.script}`;
    const scriptAbs = path.join(this.repoRootAbs, event.script);
    const child = cp.spawn(this.nodeBin, [scriptAbs], {
      cwd: this.denormStr(event.cwd),
      env: this.childEnv(event.env),
      stdio: ["pipe", "ignore", "inherit"],
    });
    this.procs.set(event.proc, child);
  }

  private async stopProc(proc: number): Promise<void> {
    this.blockedOn = `proc stop ${proc}`;
    const child = this.procs.get(proc);
    this.procs.delete(proc);
    if (!child) {
      return;
    }
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      try {
        child.kill("SIGTERM");
      } catch {
        resolve();
      }
    });
  }

  // --- denormalization + comparison --------------------------------------------------------------

  /** Denormalize env values, layer a hermetic base (node dir pinned on PATH, git config neutralized). */
  private childEnv(recorded: Record<string, string>): NodeJS.ProcessEnv {
    const denorm: Record<string, string> = {};
    for (const [k, v] of Object.entries(recorded)) {
      denorm[k] = this.denormStr(v);
    }
    return {
      ...denorm,
      PATH: `${path.dirname(this.nodeBin)}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  /** Denormalize stdin, then materialize each {{FILE:n}} aux file to a temp path and rewrite the field
   *  (e.g. codex's transcript_path) to it. The temp path is keyed by BOTH the invocation and the
   *  placeholder so concurrently-inflight Stop hooks (both carry {{FILE:0}}) never race on one file. */
  private materializeStdin(event: HookStartEvent): string {
    let stdin = this.denormStr(event.stdin);
    for (const [placeholder, content] of Object.entries(event.files ?? {})) {
      const filePath = path.join(this.fileDir, `inv${event.inv}-f${aliasFor(placeholder)}`);
      fs.writeFileSync(filePath, this.denormStr(content), "utf8");
      stdin = stdin.split(placeholder).join(filePath);
    }
    return stdin;
  }

  /** Denormalize a normalized string back to the current run's values (placeholders → real). The deep
   *  message denormalizer handles a bare string as its leaf case. */
  private denormStr(value: string): string {
    return denormalizeMessage(value, this.subst) as string;
  }

  /** Compare an expected (tape, already normalized) stdout string against a normalized actual one.
   *  Returns null when equal, else a readable divergence report. */
  private compareStdout(expectedNorm: string, actualRaw: string): string | null {
    const actualNorm = normalizeMessage(actualRaw, "in", this.subst) as string;
    if (actualNorm === expectedNorm) {
      return null;
    }
    // Gate-decision stdout is JSON — a key-path diff reads better than two opaque blobs.
    const expObj = tryParse(expectedNorm);
    const actObj = tryParse(actualNorm);
    if (expObj !== undefined && actObj !== undefined) {
      const diff = compareMessages(expObj, actObj);
      return renderDivergence({
        seq: this.seqIndex,
        conn: 0,
        type: "hook stdout",
        expected: expObj,
        actual: actObj,
        paths: diff.paths,
      });
    }
    return `--- expected (tape) ---\n${expectedNorm}\n--- actual ---\n${actualNorm}`;
  }
}

function tryParse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/** A short filename alias for a {{FILE:n}} placeholder (its index). */
function aliasFor(placeholder: string): string {
  const m = /\{\{FILE:(\d+)\}\}/.exec(placeholder);
  return m ? m[1] : "0";
}

/** The `node` binary to spawn hook scripts with. The extension host runs under Electron, so
 *  process.execPath is wrong — runE2E passes the runner's node dir as PAIRETO_NODE_DIR. */
function resolveNodeBin(): string {
  const dir = process.env.PAIRETO_NODE_DIR ?? path.dirname(process.execPath);
  return path.join(dir, process.platform === "win32" ? "node.exe" : "node");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}
