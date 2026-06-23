// Wire-protocol types shared between the VS Code extension (socket server) and the
// Claude Code plugin hook scripts. The hook scripts are plain JS and re-implement the
// same shapes by hand — keep this file the single source of truth and mirror changes there.

/** Bump when the on-wire shape changes incompatibly. Sent in every envelope as `v`. */
export const PROTOCOL_VERSION = 1;

/** Real Claude Code hook events we subscribe to. `MessageDisplay` deliberately omitted (does not exist). */
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "Notification"
  | "PermissionRequest"
  | "CwdChanged"
  | "FileChanged"
  | "WorktreeCreate"
  | "WorktreeRemove";

/** Message type tags carried in the envelope `t` field. */
export type MessageType =
  | "hello"
  | "hello.ack"
  | "hook.event"
  | "plan.review.request"
  | "plan.review.response"
  | "review.await.request"
  | "review.await.response";

export interface Envelope {
  /** Message type tag. */
  t: MessageType;
  /** Protocol version. */
  v: number;
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

/** Fire-and-forget telemetry carrying a passive hook event. No `id` — the hook never waits. */
export interface HookEventMessage extends Envelope {
  t: "hook.event";
  event: HookEventName;
  sessionId: string;
  /** Present only in subagent context. */
  agentId?: string;
  agentType?: string;
  cwd: string;
  repoRoot: string;
  permissionMode?: string;
  /** Present only on tool events. */
  toolName?: string;
  toolInput?: unknown;
  transcriptPath?: string;
}

/** Blocking plan-gate request. Carries an `id`; the hook blocks until the matching response. */
export interface PlanReviewRequest extends Envelope {
  t: "plan.review.request";
  id: string;
  sessionId: string;
  agentId?: string;
  cwd: string;
  repoRoot: string;
  permissionMode?: string;
  toolName: string;
  /** The plan markdown, taken from the ExitPlanMode tool_input.plan field. */
  plan: string;
}

export type PlanDecision = "allow" | "deny";

/** Extension's response to a {@link PlanReviewRequest}; same `id`. */
export interface PlanReviewResponse extends Envelope {
  t: "plan.review.response";
  id: string;
  decision: PlanDecision;
  /** Feedback surfaced back to Claude on deny. */
  reason?: string;
}

/**
 * Blocking code-review session. Sent by the MCP `tui_review` tool when the agent starts a review;
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

export type AnyMessage =
  | HelloMessage
  | HelloAckMessage
  | HookEventMessage
  | PlanReviewRequest
  | PlanReviewResponse
  | ReviewAwaitRequest
  | ReviewAwaitResponse;
