// A compact, codicon-prefixed one-liner for a repo's agent activity. Shared so any surface that
// summarizes activity (currently the repo/worktree switcher) renders states the same way.

import type { RepoActivity } from "./AgentSessionService.js";

export function summarizeActivity(
  activity: RepoActivity | undefined,
  needsAttention = false,
): string {
  // The orange bell shown as the row's left icon carries the visual cue; keep the text plain.
  if (needsAttention) {
    return "needs you";
  }
  if (!activity || activity.sessionCount === 0) {
    return "idle";
  }
  const agents = activity.sessionCount > 1 ? ` · ${activity.sessionCount} agents` : "";
  switch (activity.state) {
    case "awaitingPlanApproval":
      return `$(comment-discussion) plan review`;
    case "awaitingPermission":
      return `$(warning) awaiting permission`;
    case "awaitingInput":
      return `$(question) awaiting input`;
    case "stopped":
      return `$(primitive-square) finished`;
    case "toolRunning":
      return `$(tools) running tool${agents}`;
    case "thinking":
      return `$(loading~spin) thinking${agents}`;
    default:
      return `$(circle-outline) idle${agents}`;
  }
}
