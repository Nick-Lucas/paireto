// Wire-protocol types shared between the VS Code extension (socket server) and the
// Claude Code plugin hook scripts. The hook scripts are plain JS and re-implement the
// same shapes by hand — keep this file the single source of truth and mirror changes there.

import pluginManifest from "../../plugins/claude-code/.claude-plugin/plugin.json";

// The per-harness raw-event dialects live in their strategy files (agent-specific types belong with
// the one module that consumes them); this file imports them TYPE-ONLY for the HarnessHookEvent
// union below. The resulting cycle (strategies import Harness from here) is erased at compile time.
import type { ClaudeCodeHookEvent } from "../harness/ClaudeCodeStrategy.js";
import type { CodexHookEvent } from "../harness/CodexStrategy.js";
import type { OpenCodeForwardedEvent } from "../harness/OpenCodeStrategy.js";

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
 *  which raw-event dialect (see {@link HarnessHookEvent}) it's receiving — see
 *  `src/harness/AgentStrategy.ts` (and the per-harness strategies) for the mapping into a common
 *  internal representation.
 *  A new harness extends this union and gets its own strategy; nothing else needs to change. */
export type Harness = "claudecode" | "codex" | "opencode";

/** The raw hook/event payload carried on the wire, in whichever harness's dialect the `harness`
 *  field names. Each strategy consumes only its own member (narrowed at the boundary by the runtime
 *  `harness` tag — see AgentStrategy's bivariance note). */
export type HarnessHookEvent = ClaudeCodeHookEvent | CodexHookEvent | OpenCodeForwardedEvent;

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
 *  is the raw harness payload passed through as-is (see {@link HarnessHookEvent}, whichever dialect
 *  `harness` names); `harness` and `repoRoot` are the bridge's own envelope metadata. */
export interface HookEventMessage extends Envelope {
  t: "hook.event";
  harness: Harness;
  repoRoot: string;
  event: HarnessHookEvent;
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
 *  is the raw harness payload carrying the plan (see {@link HarnessHookEvent}): Claude's ExitPlanMode
 *  PermissionRequest (`event.tool_input.plan`), or a Codex/OpenCode event with an adapter-injected
 *  `plan_markdown`. */
export interface PlanReviewRequest extends Envelope {
  t: "plan.review.request";
  id: string;
  harness: Harness;
  repoRoot: string;
  event: HarnessHookEvent;
}

export type PlanDecision = "allow" | "deny";

/** Extension's response to a {@link PlanReviewRequest}; same `id`. */
export interface PlanReviewResponse extends Envelope {
  t: "plan.review.response";
  id: string;
  decision: PlanDecision;
  /** Feedback surfaced back to the agent on deny. */
  reason?: string;
  /** On allow: a per-harness "what next" hint. HARNESS-DEPENDENT meaning: for claudecode it's the
   *  permission MODE to enter (e.g. "auto"), applied via the PermissionRequest
   *  `decision.updatedPermissions` setMode; for opencode it's the TARGET AGENT to switch to (e.g.
   *  "build"), which the plugin's paireto_submit_plan tool prompts into action. Omitted = leave
   *  things unchanged ("off"). */
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
  event: HarnessHookEvent;
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
