// Cross-cutting domain types shared across plan review, code review, and agent tracking.

export type Severity = "note" | "suggestion" | "blocking";

export type ReviewMode = "unstaged" | "staged" | "uncommitted" | "branch" | "commitRange";

export interface ReviewSpec {
  mode: ReviewMode;
  baseRef?: string;
  compareRef?: string;
  includeUntracked: boolean;
}

/** Headline agent state derived from Claude hook telemetry; drives the status-bar glyph. */
export type AgentState =
  | "idle"
  | "thinking"
  | "toolRunning"
  | "awaitingPlanApproval"
  | "awaitingPermission"
  | "stopped"
  | "ended";

export interface AgentSession {
  sessionId: string;
  repoRoot: string;
  state: AgentState;
  subagentCount: number;
  lastTool?: string;
  startedAt: number;
  lastEventAt: number;
}
