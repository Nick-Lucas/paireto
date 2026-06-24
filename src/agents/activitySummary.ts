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
  const subs = activity.subagentCount > 0 ? ` · ${activity.subagentCount} sub` : "";
  switch (activity.state) {
    case "awaitingPlanApproval":
      return `$(comment-discussion) plan review${subs}`;
    case "awaitingPermission":
      return `$(warning) awaiting permission${subs}`;
    case "stopped":
      return `$(primitive-square) finished${subs}`;
    case "toolRunning":
      return `$(tools) running tool${agents}${subs}`;
    case "thinking":
      return `$(loading~spin) thinking${agents}${subs}`;
    default:
      return `$(circle-outline) idle${agents}`;
  }
}
