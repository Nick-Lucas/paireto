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
  // A Notification said Claude wants input (question prompt / elicitation form) — the generic
  // needs-you state for input requests that have no dedicated hook event.
  | "awaitingInput"
  | "stopped"
  | "ended";

// Per-session agent state and behaviour live on the AgentSession class (src/agents/AgentSession.ts).
