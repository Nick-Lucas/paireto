// Bridges the async gap between an inbound plan-gate request (held open on the socket) and the
// user's eventual Approve / Send-Feedback click in the editor. The bridge handler awaits a
// decision here; the plan UI fulfills it. Keyed by sessionId:planId so concurrent plans don't collide.

import type { PlanGateResult } from "../bridge/types.js";

interface Pending {
  resolve: (result: PlanGateResult) => void;
}

export class PlanGateRegistry {
  private readonly pending = new Map<string, Pending>();

  static key(sessionId: string, planId: string): string {
    return `${sessionId}:${planId}`;
  }

  /** Called by the bridge handler; resolves when the UI calls fulfill() for this key. */
  awaitDecision(key: string): Promise<PlanGateResult> {
    return new Promise<PlanGateResult>((resolve) => {
      // If a stale pending exists for this key, resolve it as a deny to avoid leaks.
      this.pending.get(key)?.resolve({ decision: "deny", reason: "Superseded by a newer plan." });
      this.pending.set(key, { resolve });
    });
  }

  /** Called by the plan UI on Approve / Send-Feedback. No-op if the gate already resolved. */
  fulfill(key: string, result: PlanGateResult): boolean {
    const entry = this.pending.get(key);
    if (!entry) {
      return false;
    }
    this.pending.delete(key);
    entry.resolve(result);
    return true;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  /** Resolve everything outstanding (on dispose) so no socket hangs forever. */
  drain(result: PlanGateResult): void {
    for (const [, entry] of this.pending) {
      entry.resolve(result);
    }
    this.pending.clear();
  }
}
