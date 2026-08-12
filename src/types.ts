// Cross-cutting domain types shared across plan review, code review, and agent tracking.

/** Which group a changed file belongs to in the Changes view. */
export type FileGroup = "staged" | "unstaged" | "committed";

// Compare To lives on the wire protocol: an agent names its comparison point in the guided-review
// payload, so both sides have to mean the same thing by it.
export type { CompareTo, CompareToKind } from "./protocol/types.js";

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
