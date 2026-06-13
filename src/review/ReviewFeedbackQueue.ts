// Holds code-review feedback queued from VS Code until the agent's next UserPromptSubmit hook
// pulls it (delivered to Claude via additionalContext). Keyed by sessionId; pull() drains it.

export class ReviewFeedbackQueue {
  private readonly queue = new Map<string, string[]>();

  enqueue(sessionId: string, feedback: string): void {
    const list = this.queue.get(sessionId) ?? [];
    list.push(feedback);
    this.queue.set(sessionId, list);
  }

  /** Return all queued feedback for a session as one block and clear it. */
  pull(sessionId: string): string {
    const list = this.queue.get(sessionId);
    if (!list || list.length === 0) {
      return "";
    }
    this.queue.delete(sessionId);
    return list.join("\n\n---\n\n");
  }

  pending(sessionId: string): boolean {
    return (this.queue.get(sessionId)?.length ?? 0) > 0;
  }
}
