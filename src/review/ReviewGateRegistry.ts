// Bridges the async gap between an inbound review.await.request (held open on the socket by the
// MCP tui_review tool) and the user's eventual Send-Feedback / Cancel click. The bridge handler
// awaits here; the review UI fulfills it. Keyed by request id; a newer request supersedes an older.

import type { ReviewGateResult } from "../bridge/types.js";

interface Pending {
  resolve: (result: ReviewGateResult) => void;
}

export class ReviewGateRegistry {
  private readonly pending = new Map<string, Pending>();

  /** Called by the bridge handler; resolves when the UI calls fulfill() for this id. */
  awaitDecision(id: string): Promise<ReviewGateResult> {
    return new Promise<ReviewGateResult>((resolve) => {
      // Supersede any prior pending review so its socket doesn't hang forever.
      this.pending.get(id)?.resolve({ status: "cancelled", feedback: "" });
      this.pending.set(id, { resolve });
    });
  }

  /** Called by the review UI on Send-Feedback / Cancel. No-op if already resolved. */
  fulfill(id: string, result: ReviewGateResult): boolean {
    const entry = this.pending.get(id);
    if (!entry) {
      return false;
    }
    this.pending.delete(id);
    entry.resolve(result);
    return true;
  }

  /** Resolve everything outstanding (on dispose) so no socket hangs forever. */
  drain(result: ReviewGateResult): void {
    for (const [, entry] of this.pending) {
      entry.resolve(result);
    }
    this.pending.clear();
  }
}
