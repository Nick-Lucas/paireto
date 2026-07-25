// The shared replay executor: a single sequential loop over a tape's events with a
// driver-checkpoint rendezvous. Both replay emulators — HookHarnessEmulator
// (claude+codex, spawns the real hook scripts) and OpenCodePluginHost (opencode, invokes the real
// plugin in-process) — extend this and implement only the per-event `step`. The base owns the loop,
// the driver checkpoints, fail/screen, and the drain/assertComplete contract the ReplayDriver calls.
//
// Concurrency: `start()` runs the loop fire-and-forget. It races ahead through the tape but parks at
// (a) each `driver` checkpoint until the test calls the matching ReplayDriver method and (b) any
// blocking step a subclass awaits (a gate hook's `hook.end` / a blocking tool's `plugin.tool.end`) —
// which the test unblocks by firing paireto.gate.* against the REAL extension. Parking can't deadlock:
// every extension→plugin message is caused by the plugin's own request or a test-fired gate command.

import { applyDelta } from "./snapshotFs.js";
import { denormalizeMessage, type Subst } from "./normalize.js";
import type { DriverCallEvent, FsDelta, Tape, TapeEvent } from "./tapeTypes.js";

/** A parked checkpoint (loop is waiting) or a pending driver call (test called ahead of the loop). */
interface DriverPark {
  event: DriverCallEvent;
  resolve: () => void;
  reject: (err: Error) => void;
}
interface DriverCall {
  method: string;
  text?: string;
  resolve: () => void;
  reject: (err: Error) => void;
}

export abstract class TapeExecutor {
  protected seqIndex = 0;
  protected blockedOn = "not started";
  protected failure?: string;
  private loopDone?: Promise<void>;
  private completed = false;
  private drained = false;

  // Driver-checkpoint rendezvous: at most one side waits at a time.
  private parkedCheckpoint?: DriverPark;
  private pendingCall?: DriverCall;

  constructor(
    protected readonly tape: Tape,
    protected readonly repoRoot: string,
    protected readonly subst: Subst,
  ) {}

  /** Begin executing the tape (fire-and-forget; the test drives via callDriver + observes screen()). */
  start(): void {
    this.loopDone = this.runLoop();
  }

  /** Called by ReplayDriver for each driver method. Rendezvous with the loop's matching checkpoint:
   *  verify method (+ text), then release both sides. A mismatch fails the call AND the run. */
  callDriver(method: string, text?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // The loop already diverged and stopped — reject now rather than hang (a driver call has no
      // step timeout of its own).
      if (this.failure) {
        reject(new Error(`replay already diverged before driver.${method}:\n${this.failure}`));
        return;
      }
      const parked = this.parkedCheckpoint;
      if (parked) {
        this.parkedCheckpoint = undefined;
        this.settleCheckpoint(parked.event, method, text, {
          onOk: () => {
            parked.resolve();
            resolve();
          },
          onErr: (err) => {
            parked.reject(err);
            reject(err);
          },
        });
        return;
      }
      this.pendingCall = { method, text, resolve, reject };
    });
  }

  /** Current status / divergence text for failure dumps (leads every waitFor dump via ReplayDriver). */
  screen(): string {
    if (this.failure) {
      return this.failure;
    }
    const extra = this.status();
    return (
      `REPLAY[${this.tape.harness}]: seq ${this.seqIndex}/${this.tape.events.length}, ` +
      `blocked on ${this.blockedOn}${extra ? ` — ${extra}` : ""}`
    );
  }

  /** Wait for the loop to drain, then run the subclass leftover check while resources are still live
   *  (unconsumed tape / extra received messages = a divergence). MUST run before teardown. Idempotent. */
  async drain(): Promise<void> {
    await this.settleLoop();
    if (this.drained) {
      return;
    }
    this.drained = true;
    const leftover = this.drainCheck();
    if (leftover) {
      // fail() keeps the first divergence, so a real earlier mismatch still wins over this.
      this.fail(leftover);
    }
  }

  /** After a passing flow: assert the tape fully replayed with no divergence, then tear down. */
  async assertComplete(): Promise<void> {
    await this.drain();
    if (this.failure) {
      throw new Error(`replay diverged:\n${this.failure}`);
    }
    if (!this.completed) {
      throw new Error(
        `replay incomplete: stopped at seq ${this.seqIndex}/${this.tape.events.length} ` +
          `(blocked on ${this.blockedOn})`,
      );
    }
    this.teardown();
  }

  /** Tear down whatever the loop left live (used by dispose() before assertComplete runs). */
  finish(): void {
    this.teardown();
  }

  // --- Subclass hooks ----------------------------------------------------------------------------

  /** Apply one event that is neither a `driver` checkpoint nor `fs.final` (those the base handles).
   *  Throw on divergence — the loop catches it and records the failure. */
  protected abstract step(event: TapeEvent): Promise<void>;

  /** Leftover check run at drain: a human-readable message if the tape wasn't fully consumed / extra
   *  messages arrived, else undefined. */
  protected abstract drainCheck(): string | undefined;

  /** Release every process/socket/handle the loop opened. Idempotent. */
  protected abstract teardown(): void;

  /** Extra one-line status appended to screen() (e.g. inflight invocations); "" for none. */
  protected abstract status(): string;

  // --- Shared helpers for subclasses -------------------------------------------------------------

  /** Denormalize a tape delta and apply it to the sandbox working tree (so the extension's real-file
   *  assertions pass with no harness ever writing). */
  protected applyFs(delta: FsDelta): void {
    applyDelta(this.repoRoot, denormalizeMessage(delta, this.subst) as FsDelta);
  }

  /** Record the first divergence, print it immediately (visible live in the runner), and stop. */
  protected fail(message: string): void {
    if (this.failure) {
      return;
    }
    this.failure = message;
    console.error(`\n=== TAPE DIVERGENCE (${this.tape.harness}) ===\n${message}\n`);
    // Reject either rendezvous half so a driver call that's waiting (or parked) fails fast instead of
    // hanging — the loop has stopped and no checkpoint will ever be reached.
    const parked = this.parkedCheckpoint;
    if (parked) {
      this.parkedCheckpoint = undefined;
      parked.reject(new Error(message));
    }
    const call = this.pendingCall;
    if (call) {
      this.pendingCall = undefined;
      call.reject(new Error(message));
    }
  }

  // --- The sequential executor -------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    try {
      for (this.seqIndex = 0; this.seqIndex < this.tape.events.length; this.seqIndex++) {
        if (this.failure) {
          return;
        }
        await this.dispatch(this.tape.events[this.seqIndex]);
      }
      if (!this.failure) {
        this.completed = true;
      }
    } catch (err) {
      this.fail(errText(err));
    }
  }

  private async dispatch(event: TapeEvent): Promise<void> {
    if (event.k === "driver") {
      await this.awaitCheckpoint(event);
      return;
    }
    if (event.k === "fs.final") {
      this.applyFs(event.fs);
      return;
    }
    await this.step(event);
  }

  private awaitCheckpoint(event: DriverCallEvent): Promise<void> {
    this.blockedOn = `driver checkpoint ${event.method}`;
    return new Promise<void>((resolve, reject) => {
      const call = this.pendingCall;
      if (call) {
        this.pendingCall = undefined;
        this.settleCheckpoint(event, call.method, call.text, {
          onOk: () => {
            call.resolve();
            resolve();
          },
          onErr: (err) => {
            call.reject(err);
            reject(err);
          },
        });
        return;
      }
      this.parkedCheckpoint = { event, resolve, reject };
    });
  }

  /** Verify a driver call against the tape's checkpoint; run onOk/onErr. A mismatch fails the run. */
  private settleCheckpoint(
    event: DriverCallEvent,
    method: string,
    text: string | undefined,
    cb: { onOk: () => void; onErr: (err: Error) => void },
  ): void {
    if (event.method !== method) {
      const err = new Error(
        `driver call out of order at seq ${event.seq}: tape expected ${event.method}, got ${method}`,
      );
      this.fail(err.message);
      cb.onErr(err);
      return;
    }
    if (event.text !== undefined && event.text !== text) {
      const err = new Error(
        `prompt text mismatch at seq ${event.seq}:\n  tape: ${JSON.stringify(event.text)}\n  got:  ${JSON.stringify(text)}`,
      );
      this.fail(err.message);
      cb.onErr(err);
      return;
    }
    cb.onOk();
  }

  /** Wait for the loop to finish, but never hang the whole run if it's stuck on a phantom step. */
  private async settleLoop(): Promise<void> {
    if (!this.loopDone) {
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5_000);
    });
    await Promise.race([this.loopDone, grace]);
    clearTimeout(timer!);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
