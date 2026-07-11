// The Codex harness strategy: maps Codex's PascalCase hook vocabulary into the common AppEvent,
// owns the edit-tool classification and plan-proposal detection, and renders the raw-event debug
// line. Like ClaudeCodeStrategy, this is the ONLY module that knows Codex's wire dialect (beyond the
// wire types) — everything downstream sees only AppEvent. Empirically pinned against codex-cli
// 0.144.1 (see the adapter design notes): no Notification / SessionEnd / CwdChanged / FileChanged
// (Codex has no equivalents) and no background_tasks/session_crons. Process death IS caught early by
// the stdio-MCP liveness server (plugins/codex/mcp/liveness.js, PPID handoff) via the generic
// session.attach path, but supportsLiveness stays FALSE so the silence sweep remains the backstop for
// a never-attached session (see the CodexStrategy notes below).

import type { Harness } from "../protocol/types.js";
import type { AppEvent, AppEventKind } from "./appEvent.js";
import type { AgentStrategy } from "./AgentStrategy.js";

// --- Codex wire dialect -------------------------------------------------------------------------
// The raw Codex hook payloads live HERE (colocated with the only module that consumes them), not in
// protocol/types.ts — that file re-imports them type-only for the HarnessHookEvent union. snake_case
// throughout, matching Codex's own wire format; no catch-all index signature (an undocumented field
// simply isn't accessible here, on purpose).

/** Codex hook events we subscribe to (PascalCase `hook_event_name` values, empirically pinned
 *  against codex-cli 0.144.1). No Notification / SessionEnd / CwdChanged / FileChanged — Codex has
 *  no equivalents. */
export type CodexHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PermissionRequest"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop";

/** Codex `permission_mode` values. Only `"bypassPermissions"` (forced by `codex exec`) was
 *  live-pinned; `"plan"` (the plan-collaboration mode the plan gate keys on) is source-confirmed
 *  (ModeKind::Plan) but TUI-only, so it could not be empirically verified. Other TUI modes exist but
 *  are never consumed — the strategy only ever compares against `"plan"`, so an unlisted value simply
 *  falls through. Typed defensively, per the design's TUI-only caveat. */
export type CodexPermissionMode = "plan" | "bypassPermissions";

/**
 * The raw Codex hook payload (its stdin JSON), passed through by the Codex adapter's hook scripts
 * exactly like the Claude path. Typed to the fields empirically pinned (codex-cli 0.144.1) plus the
 * source-confirmed TUI-only ones. Note Codex uses `session_id` (a UUIDv7), NOT `thread_id`, and has
 * NO `background_tasks`/`session_crons`.
 */
export interface CodexHookEvent {
  hook_event_name: CodexHookEventName;
  session_id: string;
  transcript_path: string;
  cwd: string;
  model: string;
  permission_mode: CodexPermissionMode;
  /** UserPromptSubmit / PreToolUse / PostToolUse / Stop — the turn this event belongs to. */
  turn_id?: string;
  /** SessionStart only — e.g. `"startup"`. */
  source?: string;
  /** UserPromptSubmit only. */
  prompt?: string;
  /** Tool events. Codex mixes a Claude-style name for shell (`"Bash"`) with native names elsewhere:
   *  file edit → `"apply_patch"` (patch text in `tool_input.command`), plan → `"update_plan"`. */
  tool_name?: string;
  tool_input?: unknown;
  /** PostToolUse only: the tool's textual result. */
  tool_response?: string;
  tool_use_id?: string;
  /** Stop only: true when this Stop is our own block's re-injected follow-up (guards re-entry,
   *  exactly like Claude's `stop_hook_active`). */
  stop_hook_active?: boolean;
  /** Stop only. */
  last_assistant_message?: string;
  /** ADAPTER-INJECTED, not part of Codex's own payload: the plan markdown the Codex plugin renders
   *  from the stashed `update_plan` step array and stamps onto the plan-gate request (Codex's Stop
   *  payload carries no plan). Present only on a plan.review.request event. */
  plan_markdown?: string;
}
// ------------------------------------------------------------------------------------------------

/** The one Codex tool that edits working-tree files. Codex mixes a Claude-style name for shell
 *  (`"Bash"`) with native names elsewhere; file edits arrive as `apply_patch` (patch text in
 *  `tool_input.command`). */
const EDIT_TOOLS: ReadonlySet<string> = new Set<string>(["apply_patch"]);

// Partial so an unsubscribed/future hook name reads as undefined (dropped) rather than lying about a
// mapping. Codex has no Notification/SessionEnd/CwdChanged/FileChanged.
const CODEX_KIND: Partial<Record<CodexHookEventName, AppEventKind>> = {
  SessionStart: "sessionStart",
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  Stop: "stop",
  PermissionRequest: "permissionRequest",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
};

export class CodexStrategy implements AgentStrategy {
  readonly harness: Harness = "codex";
  readonly displayName = "Codex";
  readonly planToolName = "update_plan";
  // Codex has no settable post-approval permission mode (approving a plan leaves it in plan mode;
  // the user exits manually), so there is no default to send on approve.
  readonly defaultPlanApproveMode: string | undefined = undefined;
  // The stdio-MCP liveness server attaches via the generic session.attach path (instant socket-close
  // removal on death), but this stays FALSE so AgentSessionService's silence sweep still cleans up a
  // session that never attached (no window listening, or a state-dir divergence).
  readonly supportsLiveness = false;

  toAppEvent(event: CodexHookEvent): AppEvent | undefined {
    const kind = kindFor(event);
    if (!kind) {
      return undefined;
    }
    return {
      kind,
      harness: this.harness,
      sessionId: event.session_id,
      toolName: event.tool_name,
      isEditTool: EDIT_TOOLS.has(event.tool_name ?? ""),
      // Present only on a plan-gate request (the Codex adapter injects it from the stashed
      // update_plan steps); absent on every ordinary event.
      planText: event.plan_markdown,
      // Codex reports neither background tasks nor session crons — the false-turn-end protection has
      // only subagent events to work with (typed defensively; shapes unverified).
      backgroundTaskCount: 0,
      sessionCronCount: 0,
    };
  }

  describeEvent(event: CodexHookEvent): string {
    const agent = event.session_id ? ` agent=${event.session_id.slice(0, 8)}` : "";
    const extras = [
      event.tool_name ? `tool=${event.tool_name}` : "",
      event.permission_mode ? `mode=${event.permission_mode}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `${event.hook_event_name}${agent}${extras ? ` ${extras}` : ""}`;
  }
}

/** Codex signals a plan proposal by finishing a turn (Stop) while in plan collaboration mode — there
 *  is no ExitPlanMode tool. Classify that edge to planProposal here so the shared state machine never
 *  matches on permission_mode. Every other event maps by its hook name. */
function kindFor(event: CodexHookEvent): AppEventKind | undefined {
  if (event.hook_event_name === "Stop" && event.permission_mode === "plan") {
    return "planProposal";
  }
  return CODEX_KIND[event.hook_event_name];
}
