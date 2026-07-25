// The replay-mode HarnessDriver: a HarnessDriver over one of the replay emulators, with NO
// harness/tmux/credentials. It picks HookHarnessEmulator (claude/codex — spawns the real hook scripts)
// or OpenCodePluginHost (opencode — runs the real plugin in-process), both re-driving the REAL plugin
// against the REAL extension while emulating only the harness from the tape. isAvailable() is just
// "does a committed tape exist" (no binaries probed, so a stripped-PATH CI box still runs). The four
// driver methods drive the emulator's checkpoints; the test body is byte-identical to a live run.
// screen() surfaces the emulator's status/divergence so a waitFor timeout dump leads with the reason.

import * as fs from "node:fs";

import * as vscode from "vscode";

import { canonicalize, socketPath } from "../../protocol/paths.js";
import type { DriverCaps, DriverContext, HarnessDriver } from "../drivers/types.js";
import { HookHarnessEmulator } from "./HookHarnessEmulator.js";
import { OpenCodePluginHost } from "./OpenCodePluginHost.js";
import { buildReplaySubst, type ReplaySubst } from "./replaySubst.js";
import type { InspectSnapshot } from "../inspectTypes.js";
import { recordingPath } from "./recordingPath.js";
import type { TapeExecutor } from "./TapeExecutor.js";
import { isTape, type Tape } from "./tapeTypes.js";

const SOCKET_WAIT_MS = 30_000;

// The test body branches on caps (turnEndReview, the opencode special-case) so replay must report the
// SAME caps its real driver does. Kept as a static map on purpose — constructing a real driver to read
// them would pull in harness deps and break the stripped-PATH hermeticity replay exists for.
const CAPS_BY_HARNESS: Record<string, DriverCaps> = {
  claudecode: { planFeedbackReopens: true, turnEndReview: "blocking", afterApprove: "tui-select" },
  codex: { planFeedbackReopens: true, turnEndReview: "blocking", afterApprove: "tui-select" },
  opencode: { planFeedbackReopens: true, turnEndReview: "post-hoc", afterApprove: "agent-switch" },
};

export class ReplayDriver implements HarnessDriver {
  readonly harness: string;
  readonly caps: DriverCaps;
  private executor?: TapeExecutor;
  private replaySubst?: ReplaySubst;

  constructor(harness: string) {
    this.harness = harness;
    const caps = CAPS_BY_HARNESS[harness];
    if (!caps) {
      throw new Error(`no replay caps for harness "${harness}"`);
    }
    this.caps = caps;
  }

  /** Available iff a committed tape exists — no binary/auth probing (that's the whole point). */
  isAvailable(): Promise<boolean | string> {
    const tapePath = recordingPath(this.harness);
    if (fs.existsSync(tapePath)) {
      return Promise.resolve(true);
    }
    return Promise.resolve(
      `no recording at ${tapePath}; record one with PAIRETO_E2E_RECORDER_MODE=record`,
    );
  }

  async launch(ctx: DriverContext): Promise<void> {
    const tape = this.loadTape();
    const repoRoot = canonicalize(ctx.repoRoot);
    // Force activation + wait for the extension to bind socket A before the emulator dials it.
    await waitForExtensionReady(socketPath(repoRoot), SOCKET_WAIT_MS);
    this.replaySubst = buildReplaySubst(tape);
    this.executor = this.makeExecutor(tape, repoRoot);
    this.executor.start();
    await this.executor.callDriver("launch");
  }

  enterPlanMode(): Promise<void> {
    return this.executor!.callDriver("enterPlanMode");
  }

  prompt(text: string): Promise<void> {
    return this.executor!.callDriver("prompt", text);
  }

  afterPlanApprove(): Promise<void> {
    return this.executor!.callDriver("afterPlanApprove");
  }

  screen(): Promise<string> {
    return Promise.resolve(this.executor ? this.executor.screen() : "<replay: not launched>");
  }

  /** Assert the tape fully replayed with no divergence, then tear the emulator down. */
  async assertComplete(): Promise<void> {
    if (this.executor) {
      await this.executor.assertComplete();
    }
  }

  async dispose(): Promise<void> {
    // Drain (leftover check) while resources are still live, THEN tear them down — assertComplete runs
    // later (post-run hook), after finish() would otherwise have released everything.
    if (this.executor) {
      await this.executor.drain();
      this.executor.finish();
    }
    this.replaySubst?.cleanup();
  }

  private makeExecutor(tape: Tape, repoRoot: string): TapeExecutor {
    const subst = this.replaySubst!.subst;
    if (this.harness === "opencode") {
      return new OpenCodePluginHost(tape, repoRoot, subst, reviewPending);
    }
    return new HookHarnessEmulator(tape, repoRoot, subst);
  }

  private loadTape(): Tape {
    const tapePath = recordingPath(this.harness);
    const parsed: unknown = JSON.parse(fs.readFileSync(tapePath, "utf8"));
    if (!isTape(parsed)) {
      throw new Error(`malformed tape at ${tapePath}`);
    }
    return parsed;
  }
}

/** Poll until the extension is active AND has bound socket A. The extension activates on
 *  onStartupFinished, so the test-plane command throws until then — swallow and retry. */
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
    `extension not ready within ${budgetMs}ms (activated=${activated}, socket=${fs.existsSync(socketA)}): ${socketA}`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether the extension currently has a review gate pending — the OpenCodePluginHost uses this to
 *  serialize post-hoc review gates. Reads the same test-control-plane snapshot the test body does. */
async function reviewPending(): Promise<boolean> {
  try {
    const snap = (await vscode.commands.executeCommand("paireto.test.inspect")) as InspectSnapshot;
    return snap.reviewActive || snap.gates.some((g) => g.kind === "review");
  } catch {
    return false; // extension not ready / transient — treat as no gate.
  }
}
