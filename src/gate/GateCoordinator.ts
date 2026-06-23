// One-at-a-time gate slot shared by Plan Review and Code Review. A held-open ExitPlanMode plan and
// a /tui-review session must never be active simultaneously (their controls and comment surfaces
// would collide), so both acquire this single slot before opening any UI and release it when their
// gate resolves. A second request waits its turn — its hook is already blocked on the socket, so
// queueing is free — and drops out cleanly if its connection disconnects first (the abort signal).
//
// The coordinator also tracks the active GateSession so the shared `gate.approve` / `gate.sendFeedback`
// commands can dispatch to whichever flow is running.

export type GateKind = "plan" | "review";

/** The active flow behind the shared Approve / Send-Feedback commands. */
export interface GateSession {
  readonly kind: GateKind;
  approve(): void | Promise<void>;
  sendFeedback(): void | Promise<void>;
}

function abortError(): Error {
  const err = new Error("Gate acquisition aborted");
  err.name = "AbortError";
  return err;
}

export class GateCoordinator {
  private locked = false;
  private active?: GateSession;
  /** Grant callbacks for queued acquirers, in arrival order. */
  private readonly waiters: Array<() => void> = [];

  /** The currently-active gate session, if any. */
  get current(): GateSession | undefined {
    return this.active;
  }

  isActive(): boolean {
    return this.active !== undefined;
  }

  /**
   * Acquire the single gate slot for `session`. Resolves with a release function once the slot is
   * free and this session is active. Rejects with an AbortError if `signal` aborts while waiting in
   * the queue (the caller's connection dropped before it got a turn). Call the returned release when
   * the gate resolves; it clears the slot and lets the next waiter in. Release is idempotent.
   */
  async acquire(session: GateSession, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      throw abortError();
    }
    await this.waitForSlot(signal);
    this.active = session;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.active === session) {
        this.active = undefined;
      }
      this.startNext();
    };
  }

  /** Resolve when the slot is free (immediately if idle, else when granted from the queue). */
  private waitForSlot(signal?: AbortSignal): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", onAbort);
        this.locked = true;
        resolve();
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) {
          this.waiters.splice(i, 1);
        }
        reject(abortError());
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Free the slot and hand it to the next queued waiter, if any. */
  private startNext(): void {
    this.locked = false;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }
}
