// The common internal representation every harness's raw hook event is mapped to. AgentSession,
// AgentSessionService, and PlanReviewController read ONLY this shape — never a harness's raw field
// names — so adding support for another harness means writing a new AgentStrategy mapper, not
// touching every consumer. Raw events are mapped at the bridge boundary (see AgentStrategy.toAppEvent
// and AgentServiceLocator) BEFORE they reach any of the shared classes.

import type { Harness } from "../protocol/types.js";

/** Harness-agnostic event kind. Consumers only ever see this set, so a future harness can map its
 *  own vocabulary onto it without anything downstream knowing harnesses exist. */
export type AppEventKind =
  | "sessionStart"
  | "sessionEnd"
  | "userPromptSubmit"
  | "preToolUse"
  | "postToolUse"
  | "stop"
  | "notification"
  | "permissionRequest"
  | "cwdChanged"
  | "fileChanged"
  | "subagentStart"
  | "subagentStop"
  // The agent proposed a plan and wants approval before proceeding (Claude: PreToolUse ExitPlanMode).
  // Drives AgentSession's awaitingPlanApproval state — the strategy classifies it so the state
  // machine never matches on a harness-specific tool name.
  | "planProposal";

/** Harness-agnostic notification kind — see {@link AppEvent.notificationKind}. */
export type AppNotificationKind =
  | "permissionPrompt"
  | "idlePrompt"
  | "inputNeeded"
  | "informational";

/** The common internal representation every harness's raw hook event is mapped to. */
export interface AppEvent {
  kind: AppEventKind;
  /** The harness that produced this event, stamped by its strategy. Opaque identity downstream: used
   *  only for the agent-row display name (via the locator) and to pick the per-harness plan-approve
   *  mode — never interpreted beyond a locator lookup. */
  harness: Harness;
  sessionId: string;
  /** Present only in subagent context. */
  agentId?: string;
  /** Present only on tool events; display-only from here on (the agent-row's last-tool label). */
  toolName?: string;
  /** The strategy classified this tool as one that edits working-tree files — read on postToolUse to
   *  mark the turn as having touched files. Harness-owned so the classification (e.g. Claude's
   *  Edit/Write/MultiEdit/NotebookEdit) never lives in the shared state machine. */
  isEditTool?: boolean;
  /** Plan markdown, when this event carries one (e.g. Claude Code's ExitPlanMode PermissionRequest). */
  planText?: string;
  /** Present only on notification-kind events. */
  notificationKind?: AppNotificationKind;
  /** Background work known to be pending as of this event — 0 if the harness has no such concept,
   *  or is on a version that doesn't report it. */
  backgroundTaskCount: number;
  sessionCronCount: number;
}
