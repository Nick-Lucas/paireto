// Converts a harness's raw hook event (see ClaudeCodeHookEvent — Claude Code's own snake_case/
// PascalCase wire vocabulary) into a common internal representation, the "app event". AgentSession,
// AgentSessionService, and PlanReviewController read ONLY this shape — never a harness's raw field
// names — so adding support for another harness means adding a mapper here, not touching every
// consumer.

import type { ClaudeCodeHookEvent, Harness, ClaudeCodeNotificationType } from "../protocol/types.js";

/** Harness-agnostic event kind. One entry per Claude Code hook event today, but consumers only ever
 *  see this set, so a future harness can map its own vocabulary onto it without anything downstream
 *  knowing harnesses exist. */
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
  | "subagentStop";

/** Harness-agnostic notification kind — see {@link AppEvent.notificationKind}. */
export type AppNotificationKind =
  | "permissionPrompt"
  | "idlePrompt"
  | "inputNeeded"
  | "informational";

/** The common internal representation every harness's raw hook event is mapped to. */
export interface AppEvent {
  kind: AppEventKind;
  sessionId: string;
  /** Present only in subagent context. */
  agentId?: string;
  /** Present only on tool events. */
  toolName?: string;
  /** Plan markdown, when this event carries one (e.g. Claude Code's ExitPlanMode PermissionRequest). */
  planText?: string;
  /** Present only on notification-kind events. */
  notificationKind?: AppNotificationKind;
  /** Background work known to be pending as of this event — 0 if the harness has no such concept,
   *  or is on a version that doesn't report it. */
  backgroundTaskCount: number;
  sessionCronCount: number;
}

/** Map a raw hook event from the given harness into the common internal representation. */
export function transformHarnessEventToAppEvent(
  harness: Harness,
  event: ClaudeCodeHookEvent,
): AppEvent {
  switch (harness) {
    case "claudecode":
      return transformClaudeCodeEvent(event);
  }
}

const CLAUDE_CODE_KIND: Record<ClaudeCodeHookEvent["hook_event_name"], AppEventKind> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  Stop: "stop",
  Notification: "notification",
  PermissionRequest: "permissionRequest",
  CwdChanged: "cwdChanged",
  FileChanged: "fileChanged",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
};

function transformClaudeCodeEvent(event: ClaudeCodeHookEvent): AppEvent {
  return {
    kind: CLAUDE_CODE_KIND[event.hook_event_name],
    sessionId: event.session_id,
    agentId: event.agent_id,
    toolName: event.tool_name,
    planText: extractClaudeCodePlanText(event.tool_input),
    notificationKind: transformClaudeCodeNotification(event.notification_type),
    backgroundTaskCount: event.background_tasks?.length ?? 0,
    sessionCronCount: event.session_crons?.length ?? 0,
  };
}

/**
 * Claude's user-wanting notification kinds overlap the hook-driven states (permission_prompt
 * accompanies PermissionRequest, idle_prompt accompanies Stop); informational kinds (auth_success,
 * agent_completed, elicitation bookkeeping) collapse to "informational". A MISSING type (older CLI)
 * is treated as a generic input request, preserving the pre-normalization behavior.
 */
function transformClaudeCodeNotification(type: ClaudeCodeNotificationType | undefined): AppNotificationKind {
  switch (type) {
    case undefined:
    case "elicitation_dialog":
    case "agent_needs_input":
      return "inputNeeded";
    case "permission_prompt":
      return "permissionPrompt";
    case "idle_prompt":
      return "idlePrompt";
    default:
      return "informational";
  }
}

/** ExitPlanMode's plan markdown lives at `tool_input.plan` — untyped on the raw hook event, so pull
 *  it out defensively rather than assuming its shape. */
function extractClaudeCodePlanText(toolInput: unknown): string | undefined {
  if (toolInput && typeof toolInput === "object" && "plan" in toolInput) {
    const plan = (toolInput as { plan: unknown }).plan;
    if (typeof plan === "string") {
      return plan;
    }
  }
  return undefined;
}
