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
  cwd: string;
  repoRoot: string;
  sessionId?: string;
  agentId?: string;
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
