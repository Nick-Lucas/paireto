// Wire-protocol types shared between the VS Code extension (socket server) and the
// Claude Code plugin hook scripts. The hook scripts are plain JS and re-implement the
// same shapes by hand — keep this file the single source of truth and mirror changes there.

import pluginManifest from "../../plugins/claude-code/.claude-plugin/plugin.json";

/**
 * Single version for the whole plugin bundle, imported directly from the plugin manifest (the one
 * point of truth — bump it there and every one of the following updates together): the wire
 * protocol marker sent as `v` in every envelope (bump the manifest whenever the wire shape changes
 * incompatibly; checked for strict equality), the plugin's own `pluginVersion` in the hello
 * handshake, the MCP server's reported `SERVER_INFO.version`, and the extension's own `extVersion`
 * in `hello.ack`. `bridge.js` reads the same manifest file directly at runtime under its own
 * `PLUGIN_VERSION` name — mirroring this file's existing convention of hand-keeping the plugin's
 * plain-JS scripts in sync with the TypeScript source of truth.
 */
export const PLUGIN_VERSION: string = pluginManifest.version;

/** Agent harness identifiers, carried on every hook-originated message so the extension side knows
 *  which raw-event dialect (see {@link ClaudeCodeHookEvent}) it's receiving — see
 *  `src/bridge/transformHarnessEventToAppEvent.ts` for the per-harness mapping into a common
 *  internal representation.
 *  A new harness extends this union and gets its own mapper; nothing else needs to change. */
export type Harness = "claudecode";

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
 * (Claude Code hooks docs' common input fields + the per-event fields we consume) — no catch-all
 * index signature, so an undocumented field simply isn't accessible here; snake_case throughout to
 * match Claude Code's own wire format.
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

/** Message type tags carried in the envelope `t` field. */
export type MessageType =
  | "hello"
  | "hello.ack"
  | "hook.event"
  | "session.attach"
  | "plan.review.request"
  | "plan.review.response"
  | "review.await.request"
  | "review.await.response"
  | "stop.gate.request"
  | "stop.gate.response";

export interface Envelope {
  /** Message type tag. */
  t: MessageType;
  /** Protocol version — see {@link PLUGIN_VERSION}. */
  v: string;
  /** Correlation id for request/response pairs. Absent for fire-and-forget telemetry. */
  id?: string;
  /** ISO-8601 timestamp from the sender. */
  ts: string;
}

/** Sent by the hook on connect; also used as the liveness probe by the resolution chain. */
export interface HelloMessage extends Envelope {
  t: "hello";
  role: "hook";
  pluginVersion: string;
  repoKey: string;
}

/** Extension's reply to {@link HelloMessage}. */
export interface HelloAckMessage extends Envelope {
  t: "hello.ack";
  role: "extension";
  extVersion: string;
  accept: boolean;
  reason?: string;
}

/** Fire-and-forget telemetry carrying a passive hook event. No `id` — the hook never waits. `event`
 *  is the raw Claude Code payload passed through as-is (see {@link ClaudeCodeHookEvent}); `harness` and
 *  `repoRoot` are the bridge's own envelope metadata, not part of Claude's payload. */
export interface HookEventMessage extends Envelope {
  t: "hook.event";
  harness: Harness;
  repoRoot: string;
  event: ClaudeCodeHookEvent;
}

/**
 * Sent once by the plugin's MCP server at session start over a connection it then HOLDS OPEN for the
 * agent's lifetime. When the agent process dies (incl. SIGKILL / terminal close, which fire no
 * SessionEnd hook), the OS closes this socket and the extension clears the session. Correlated by
 * `sessionId` (the MCP server reads CLAUDE_CODE_SESSION_ID from its env).
 */
export interface SessionAttachMessage extends Envelope {
  t: "session.attach";
  sessionId: string;
  repoRoot: string;
}

/** Blocking plan-gate request. Carries an `id`; the hook blocks until the matching response. `event`
 *  is the raw PermissionRequest payload (ExitPlanMode) — see {@link ClaudeCodeHookEvent}; the plan markdown
 *  lives at `event.tool_input.plan`. */
export interface PlanReviewRequest extends Envelope {
  t: "plan.review.request";
  id: string;
  harness: Harness;
  repoRoot: string;
  event: ClaudeCodeHookEvent;
}

export type PlanDecision = "allow" | "deny";

/** Extension's response to a {@link PlanReviewRequest}; same `id`. */
export interface PlanReviewResponse extends Envelope {
  t: "plan.review.response";
  id: string;
  decision: PlanDecision;
  /** Feedback surfaced back to Claude on deny. */
  reason?: string;
  /** On allow: the Claude permission mode to enter next (e.g. "auto"). Maps to the hook's
   *  PermissionRequest `decision.updatedPermissions` setMode. Omitted = leave the mode unchanged. */
  nextMode?: string;
}

/**
 * Blocking code-review session. Sent by the MCP `paireto_review` tool when the agent starts a review;
 * the extension reveals the review panels and holds this open until the user submits or cancels.
 */
export interface ReviewAwaitRequest extends Envelope {
  t: "review.await.request";
  id: string;
  cwd: string;
  repoRoot: string;
  /** Owning agent session, best-effort (the MCP tool may not know it). Used to attribute the review
   *  to an agent row in the Agents panel; the extension falls back to repo recency if absent. */
  sessionId?: string;
  agentId?: string;
}

export type ReviewStatus = "submitted" | "cancelled";

/** Extension's response to a {@link ReviewAwaitRequest}; same `id`. */
export interface ReviewAwaitResponse extends Envelope {
  t: "review.await.response";
  id: string;
  status: ReviewStatus;
  /** Rendered review feedback (empty when cancelled or no comments). */
  feedback: string;
}

/**
 * Blocking turn-end (Stop) gate. Sent by the Stop hook on every turn-end; the extension holds it
 * open only when a review for this session is in progress or the turn touched files, then resolves
 * with whether to block the stop (and inject feedback). Otherwise it resolves "allow" immediately.
 */
export interface StopGateRequest extends Envelope {
  t: "stop.gate.request";
  id: string;
  harness: Harness;
  repoRoot: string;
  event: ClaudeCodeHookEvent;
}

export type StopDecision = "allow" | "block";

/** Extension's response to a {@link StopGateRequest}; same `id`. */
export interface StopGateResponse extends Envelope {
  t: "stop.gate.response";
  id: string;
  decision: StopDecision;
  /** On block: the review feedback fed back to Claude so it keeps going and addresses it. */
  reason?: string;
}

export type AnyMessage =
  | HelloMessage
  | HelloAckMessage
  | HookEventMessage
  | SessionAttachMessage
  | PlanReviewRequest
  | PlanReviewResponse
  | ReviewAwaitRequest
  | ReviewAwaitResponse
  | StopGateRequest
  | StopGateResponse;
