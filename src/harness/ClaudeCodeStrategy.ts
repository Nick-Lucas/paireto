// The Claude Code harness strategy: maps Claude's snake_case/PascalCase hook vocabulary into the
// common AppEvent, owns the edit-tool classification and plan-proposal detection, and renders the
// raw-event debug line. This is the ONLY module that knows Claude Code's wire dialect (beyond the
// wire types themselves) — the rest of the extension sees only AppEvent.

import type { Harness } from "../protocol/types.js";
import type { AppEvent, AppEventKind, AppNotificationKind } from "./appEvent.js";
import type { AgentStrategy } from "./AgentStrategy.js";

// --- Claude Code wire dialect -------------------------------------------------------------------
// The raw Claude Code hook payloads live HERE (colocated with the only module that consumes them),
// not in protocol/types.ts — that file keeps the harness-agnostic envelope/messages and re-imports
// these type-only for the HarnessHookEvent union. snake_case throughout to match Claude's own wire
// format; no catch-all index signature, so an undocumented field simply isn't accessible, on purpose.

/** Real Claude Code hook events we subscribe to. `MessageDisplay` deliberately omitted (does not exist). */
export type ClaudeCodeHookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "Notification"
  | "PermissionRequest"
  | "CwdChanged"
  | "FileChanged"
  // Subagent lifecycle — counted only to gate the parent's turn-end ping
  | "SubagentStart"
  | "SubagentStop";

/** `notification_type` values of the Notification hook (Claude Code hooks docs). */
export type ClaudeCodeNotificationType =
  | "permission_prompt"
  | "idle_prompt"
  | "auth_success"
  | "elicitation_dialog"
  | "elicitation_complete"
  | "elicitation_response"
  | "agent_needs_input"
  | "agent_completed";

/** `permission_mode` values (Claude Code hooks docs' common input fields). The mode labeled
 *  "Manual" arrives as `"default"`, never `"manual"`. */
export type ClaudeCodePermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";

/** `effort.level` values (Claude Code hooks docs' common input fields). Ultracode is not a distinct
 *  level and reports as `"xhigh"`. */
export type ClaudeCodeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** One entry of the Stop/SubagentStop `background_tasks` array (Claude Code v2.1.145+). */
export interface ClaudeCodeBackgroundTaskSummary {
  id: string;
  /** Category of background work, e.g. `"bash"`, `"subagent"`, `"monitor"`, `"cron"`. */
  type: string;
  /** Current state, e.g. `"running"`, `"queued"`, `"completed"`. */
  status: string;
  description: string;
  command?: string;
  agent_type?: string;
  server?: string;
  tool?: string;
  name?: string;
}

/** One entry of the Stop/SubagentStop `session_crons` array (Claude Code v2.1.145+). */
export interface ClaudeCodeSessionCronSummary {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
}

/**
 * The raw Claude Code hook payload (its stdin JSON), passed through as-is rather than the plugin
 * hand-picking fields — so a new field Claude Code adds (e.g. `background_tasks`) is available to
 * the extension immediately, without touching the plugin scripts. Typed exactly as documented today
 * (Claude Code hooks docs' common input fields + the per-event fields we consume).
 */
export interface ClaudeCodeHookEvent {
  hook_event_name: ClaudeCodeHookEventName;
  session_id: string;
  /** UUID identifying the user prompt currently being processed. Absent until the first user input
   *  (Claude Code v2.1.196+). */
  prompt_id?: string;
  transcript_path: string;
  cwd: string;
  /** Not all events receive this field. */
  permission_mode?: ClaudeCodePermissionMode;
  /** Present for events that fire within a tool-use context (PreToolUse, PostToolUse, Stop,
   *  SubagentStop) when the current model supports the effort parameter. */
  effort?: { level: ClaudeCodeEffortLevel };
  /** Present only in subagent context. */
  agent_id?: string;
  agent_type?: string;
  /** Present only on tool events. */
  tool_name?: string;
  tool_input?: unknown;
  /** Notification hook: which kind of notification — maps user-wanting kinds onto agent states;
   *  informational kinds are ignored. */
  notification_type?: ClaudeCodeNotificationType;
  /** Notification hook: the human-readable message text. */
  message?: string;
  /** Stop/SubagentStop only (Claude Code v2.1.145+): the session is paused waiting on background
   *  work (incl. async-launched subagents, which emit no SubagentStart/Stop of their own) when
   *  nonempty. Absent on older CLI versions. */
  background_tasks?: ClaudeCodeBackgroundTaskSummary[];
  /** Stop/SubagentStop only (Claude Code v2.1.145+): a scheduled wakeup is queued when nonempty.
   *  Absent on older CLI versions. */
  session_crons?: ClaudeCodeSessionCronSummary[];
}
// ------------------------------------------------------------------------------------------------

/** Tools that edit files — running one marks the turn as having touched the working tree. */
const EDIT_TOOLS: ReadonlySet<string> = new Set<string>([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

// Partial so an undocumented/future hook_event_name (one we don't subscribe to) reads as undefined
// rather than lying about a mapping — toAppEvent then drops it.
const CLAUDE_CODE_KIND: Partial<Record<ClaudeCodeHookEventName, AppEventKind>> = {
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

export class ClaudeCodeStrategy implements AgentStrategy {
  readonly harness: Harness = "claudecode";
  readonly displayName = "Claude";
  readonly planToolName = "ExitPlanMode";
  readonly defaultPlanApproveMode: string | undefined = "auto";
  // The MCP server holds a per-session liveness socket (see SessionAttachMessage), so process death
  // is detected directly — no silence-based sweep removal needed.
  readonly supportsLiveness = true;

  toAppEvent(event: ClaudeCodeHookEvent): AppEvent | undefined {
    const kind = kindFor(event);
    if (!kind) {
      return undefined;
    }
    return {
      kind,
      harness: this.harness,
      sessionId: event.session_id,
      agentId: event.agent_id,
      toolName: event.tool_name,
      isEditTool: EDIT_TOOLS.has(event.tool_name ?? ""),
      planText: extractPlanText(event.tool_input),
      notificationKind: transformNotification(event.notification_type),
      backgroundTaskCount: event.background_tasks?.length ?? 0,
      sessionCronCount: event.session_crons?.length ?? 0,
    };
  }

  describeEvent(event: ClaudeCodeHookEvent): string {
    const agent = event.session_id ? ` agent=${event.session_id.slice(0, 8)}` : "";
    const extras = [
      event.agent_id ? `subagent=${event.agent_id.slice(0, 8)}` : "",
      event.tool_name ? `tool=${event.tool_name}` : "",
      event.notification_type ? `type=${event.notification_type}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `${event.hook_event_name}${agent}${extras ? ` ${extras}` : ""}`;
  }
}

/** ExitPlanMode is the plan-proposal edge (drives awaitingPlanApproval) — classify it here so the
 *  shared state machine never matches on the tool name. Every other event maps by its hook name. */
function kindFor(event: ClaudeCodeHookEvent): AppEventKind | undefined {
  if (event.hook_event_name === "PreToolUse" && event.tool_name === "ExitPlanMode") {
    return "planProposal";
  }
  return CLAUDE_CODE_KIND[event.hook_event_name];
}

/**
 * Claude's user-wanting notification kinds overlap the hook-driven states (permission_prompt
 * accompanies PermissionRequest, idle_prompt accompanies Stop); informational kinds (auth_success,
 * agent_completed, elicitation bookkeeping) collapse to "informational". A MISSING type (older CLI)
 * is treated as a generic input request, preserving the pre-normalization behavior.
 */
function transformNotification(type: ClaudeCodeNotificationType | undefined): AppNotificationKind {
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
function extractPlanText(toolInput: unknown): string | undefined {
  if (toolInput && typeof toolInput === "object" && "plan" in toolInput) {
    const plan = (toolInput as { plan: unknown }).plan;
    if (typeof plan === "string") {
      return plan;
    }
  }
  return undefined;
}
