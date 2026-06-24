// Cross-cutting domain types shared across plan review, code review, and agent tracking.

/** Which group a changed file belongs to in the Changes view. */
export type FileGroup = "staged" | "unstaged" | "committed";

/** The "Compare To" point that defines the Committed group. */
export type CompareToKind = "head" | "mergeBase" | "default" | "ref";

export interface CompareTo {
  kind: CompareToKind;
  /** For kind === "ref": the chosen branch/ref. */
  ref?: string;
}

/** How the Changed Files list is laid out. */
export type FileLayout = "tree" | "flat";

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
  lastTool?: string;
  startedAt: number;
  lastEventAt: number;
  /** Set when the session enters a "needs you" state (stopped / awaiting plan / awaiting permission)
   *  until the user looks at it or the agent goes busy again. Drives the sidebar attention marker. */
  needsAttention: boolean;
  /** True if an edit-class tool ran (or a file changed) since this turn began — drives whether the
   *  Stop gate opens a code review at turn-end. Reset on UserPromptSubmit. */
  changedThisTurn: boolean;
}
