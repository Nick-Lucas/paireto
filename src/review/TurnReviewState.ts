import { workingTreeFingerprint } from "../git/workingTreeFingerprint.js";
import type { AppEvent } from "../harness/appEvent.js";
import { log } from "../log.js";

/** One repository's turn-start fingerprint; `undefined` when that snapshot failed, so the
 *  comparison skips it rather than reading the failure as "nothing changed". */
type Snapshot = Map<string, string | undefined>;

export class TurnReviewState {
  private readonly turns = new Map<string, Promise<Snapshot>>();
  private inFlight = 0;

  /** `reviewRoots` is the Git surface a review would show, which is what the turn is compared over. */
  constructor(
    private readonly reviewRoots: () => readonly string[],
    private readonly fingerprint: (root: string) => Promise<string> = workingTreeFingerprint,
  ) {}

  /** True while a snapshot is still being taken, for the env-gated test control plane only. */
  get capturing(): boolean {
    return this.inFlight > 0;
  }

  observe(event: AppEvent, repoRoot: string): void {
    if (event.agentId) {
      return;
    }
    if (event.kind === "sessionEnd") {
      this.forget(event.sessionId);
    } else if (
      event.kind === "userPromptSubmit" ||
      (!this.turns.has(this.key(event.sessionId)) &&
        (event.kind === "sessionStart" || event.kind === "preToolUse"))
    ) {
      void this.resetBaseline(event.sessionId, repoRoot);
    }
  }

  async changedSinceStart(sessionId: string | undefined, repoRoot: string): Promise<boolean> {
    const baseline = await this.turns.get(this.key(sessionId));
    if (!baseline) {
      return false;
    }
    const current = await this.capture(repoRoot);
    for (const [root, fingerprint] of current) {
      const before = baseline.get(root);
      if (before !== undefined && fingerprint !== undefined && before !== fingerprint) {
        return true;
      }
    }
    return false;
  }

  /** Resolves only once the new snapshot is in place: a caller that releases the agent earlier lets
   *  the edits it makes next land in its own baseline, and the next Stop then sees no change. */
  async resetBaseline(sessionId: string | undefined, repoRoot: string): Promise<void> {
    const snapshot = this.capture(repoRoot);
    this.turns.set(this.key(sessionId), snapshot);
    await snapshot;
  }

  /** Drop a session's baseline — its agent is gone (a killed process fires no sessionEnd). */
  forget(sessionId: string | undefined): void {
    this.turns.delete(this.key(sessionId));
  }

  clear(): void {
    this.turns.clear();
  }

  private key(sessionId: string | undefined): string {
    return sessionId ?? "";
  }

  private async capture(repoRoot: string): Promise<Snapshot> {
    // Every repository the review shows, plus the agent's own: an agent in one repository of a
    // multi-root window can edit any of the others, and the review would show that edit.
    const roots = [...new Set([...this.reviewRoots(), repoRoot])];
    this.inFlight++;
    try {
      const snapshot: Snapshot = new Map();
      await Promise.all(
        roots.map(async (root) => {
          snapshot.set(root, await this.fingerprintOf(root));
        }),
      );
      return snapshot;
    } finally {
      this.inFlight--;
    }
  }

  private async fingerprintOf(root: string): Promise<string | undefined> {
    try {
      return await this.fingerprint(root);
    } catch (error) {
      log.info(`turn file check failed for ${root}: ${String(error)}`);
      return undefined;
    }
  }
}
