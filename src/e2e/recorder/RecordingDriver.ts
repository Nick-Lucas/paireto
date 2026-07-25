// Wraps the real harness driver to capture a tape. It stands up the recorder service (a short
// unix-socket NDJSON collector), generates the shims + OpenCode wrapper, and publishes them via the
// process-local record context so the real driver wires its sandbox at them (the hooks now dial the
// REAL socket directly — there is no second state home). A driver checkpoint is recorded before each
// delegated call. dispose() appends the final fs delta, seals the tape, stops the service, then tears
// the real driver down (so teardown noise never enters the tape).
//
// Availability is a HARD FAILURE in record mode: a missing binary/auth throws a clear message rather
// than skipping — a record run must exercise the real harness or fail loudly.

import * as fs from "node:fs";
import * as path from "node:path";

import * as vscode from "vscode";

import { socketPath } from "../../protocol/paths.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "../drivers/types.js";
import { clearRecordContext, setRecordContext } from "./recordContext.js";
import { generateShims } from "./recordSandbox.js";
import { RecorderService } from "./RecorderService.js";
import type { Tape, TapeEvent, TapeEventInput } from "./tapeTypes.js";
import { PLUGIN_VERSION } from "../../protocol/types.js";

const SOCKET_WAIT_MS = 30_000;

export class RecordingDriver implements HarnessDriver {
  readonly harness: string;
  readonly caps: DriverCaps;

  private service?: RecorderService;
  private workDir?: string;
  private ctx?: DriverContext;
  /** Captured events snapshotted at dispose (the service is torn down before buildTape runs). */
  private captured: TapeEvent[] = [];

  constructor(private readonly real: HarnessDriver) {
    this.harness = real.harness;
    this.caps = real.caps;
  }

  /** Record mode requires the real harness — a missing binary/auth is a hard failure, never a skip. */
  async isAvailable(): Promise<boolean | string> {
    const avail = await this.real.isAvailable();
    if (avail !== true) {
      throw new Error(
        `E2E RECORD: cannot record "${this.harness}" — ${avail}. Record mode requires the real ` +
          `harness (binary + auth + tmux). Fix the prerequisite, or run replay (the default mode).`,
      );
    }
    return true;
  }

  async launch(ctx: DriverContext): Promise<void> {
    this.ctx = ctx;
    const repoRoot = requireEnv("PAIRETO_REPO_ROOT");

    // 1. A short recorder socket under the state home (its dir is already short /tmp) + a work dir the
    //    generated shims / sandbox copies live in.
    const stateHome = requireEnv("XDG_STATE_HOME");
    const recSocket = path.join(stateHome, "paireto", `rec-${process.pid}.sock`);
    const workDir = fs.mkdtempSync("/tmp/pai-rs-");
    this.workDir = workDir;

    // 2. Start the collector, then generate + publish the shims for the real driver to wire.
    this.service = new RecorderService({ socketPath: recSocket, repoRoot: ctx.repoRoot });
    await this.service.start();
    const shims = generateShims(workDir, { socketPath: recSocket, repoRoot });
    setRecordContext({ socketPath: recSocket, repoRoot, workDir, ...shims });

    // 3. Wait for the extension to bind the REAL socket A before the harness launches (its hooks dial
    //    it directly now).
    await waitForExtensionReady(socketPath(ctx.repoRoot), SOCKET_WAIT_MS);

    // 4. Record the launch checkpoint, then delegate to the real driver (which spawns the harness).
    this.service.append({ k: "driver", method: "launch" });
    await this.real.launch(ctx);
  }

  async enterPlanMode(): Promise<void> {
    this.checkpoint({ k: "driver", method: "enterPlanMode" });
    await this.real.enterPlanMode();
  }

  async prompt(text: string): Promise<void> {
    this.checkpoint({ k: "driver", method: "prompt", text });
    await this.real.prompt(text);
  }

  async afterPlanApprove(): Promise<void> {
    this.checkpoint({ k: "driver", method: "afterPlanApprove" });
    await this.real.afterPlanApprove();
  }

  /** Unrecorded passthrough — screen() is failure-artifact plumbing, not part of the flow. */
  screen(): Promise<string> {
    return this.real.screen();
  }

  async dispose(): Promise<void> {
    // Append the final fs delta and seal BEFORE tearing the real driver down, so the teardown's own
    // SessionEnd / liveness-close traffic never lands in the tape.
    if (this.service) {
      // Drain first: the OpenCode wrapper forwards events fire-and-forget over one serial socket, so a
      // streaming turn's backlog (incl. the trailing session.idle that opens the next gate) can still
      // be in flight when the test settles. Wait for the recorder to go quiet so nothing is sealed away.
      await this.drainService(this.service);
      this.service.append({ k: "fs.final", fs: this.service.finalDelta() });
      this.service.seal();
      // Snapshot the events BEFORE tearing the service down — buildTape runs later (post-run hook).
      this.captured = this.service.captured();
      await this.service.stop();
      this.service = undefined;
    }
    await this.real.dispose();
    clearRecordContext();
    this.cleanupWorkDir();
  }

  /** The captured tape (raw, un-normalized). recorderAfterRun normalizes, lints, and writes it. */
  buildTape(): Tape {
    return {
      test: "fullflow",
      harness: this.harness,
      recordedAt: new Date().toISOString(),
      pluginVersion: PLUGIN_VERSION,
      events: this.captured,
    };
  }

  /** The driver's own log lines (used to detect the opencode retry marker at finalize). */
  driverLog(): string[] {
    return this.ctx?.log ?? [];
  }

  private checkpoint(event: TapeEventInput): void {
    this.service?.append(event);
  }

  /** Poll until the recorder has been quiet for QUIET_MS (the async wrapper backlog has flushed) or a
   *  DRAIN_BUDGET_MS ceiling. Claude/codex hooks are synchronous (nothing to drain); this matters for
   *  the OpenCode wrapper's streamed events. */
  private async drainService(service: RecorderService): Promise<void> {
    const QUIET_MS = 2000;
    const DRAIN_BUDGET_MS = 20_000;
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    while (Date.now() < deadline && service.msSinceLastEvent() < QUIET_MS) {
      await delay(250);
    }
  }

  private cleanupWorkDir(): void {
    if (!this.workDir) {
      return;
    }
    try {
      fs.rmSync(this.workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    this.workDir = undefined;
  }
}

/** Poll until the extension is active AND has bound socket A, or the budget elapses. The extension
 *  activates on `onStartupFinished` (not on our command), so the test-plane command throws
 *  "not found" until activation completes — swallow that and retry; a success proves activation ran. */
async function waitForExtensionReady(socketA: string, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let activated = false;
  while (Date.now() < deadline) {
    if (!activated) {
      try {
        await vscode.commands.executeCommand("paireto.test.inspect");
        activated = true;
      } catch {
        /* command not registered yet — extension still activating */
      }
    }
    if (activated && fs.existsSync(socketA)) {
      return;
    }
    await delay(200);
  }
  throw new Error(
    `extension not ready within ${budgetMs}ms (activated=${activated}, socket exists=${fs.existsSync(socketA)}): ${socketA}`,
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env ${name}`);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
