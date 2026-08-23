// Wire-protocol types shared between the VS Code extension (socket server) and the plugin hook
// scripts and MCP servers. The plugins are TypeScript under src/plugins/ and import these types
// directly, so both sides of the wire are checked against this one file.

import pluginManifest from "../plugins/agent-plugin/plugin.json";

// The per-harness raw-event dialects live in their strategy files (agent-specific types belong with
// the one module that consumes them); this file imports them TYPE-ONLY for the HarnessHookEvent
// union below. The resulting cycle (strategies import Harness from here) is erased at compile time.
import type { ClaudeCodeHookEvent } from "../harness/ClaudeCodeStrategy.js";
import type { CodexHookEvent } from "../harness/CodexStrategy.js";
import type { KiroHookEvent } from "../harness/KiroStrategy.js";
import type { OpenCodeForwardedEvent } from "../harness/OpenCodeStrategy.js";

/**
 * Single version for the whole plugin bundle, imported directly from the plugin manifest (the one
 * point of truth — bump it there and every one of the following updates together): the wire
 * protocol marker sent as `v` in every envelope (bump the manifest whenever the wire shape changes
 * incompatibly; checked for strict equality), the plugin's own `pluginVersion` in the hello
 * handshake, the MCP server's reported `serverInfo.version`, and the extension's own `extVersion`
 * in `hello.ack`. The plugin bundles import this same constant, so the manifest is read once.
 */
export const PLUGIN_VERSION: string = pluginManifest.version;

/** Agent harness identifiers, carried on every hook-originated message so the extension side knows
 *  which raw-event dialect (see {@link HarnessHookEvent}) it's receiving — see
 *  `src/harness/AgentStrategy.ts` (and the per-harness strategies) for the mapping into a common
 *  internal representation.
 *  A new harness extends this union and gets its own strategy; nothing else needs to change. */
export type Harness = "claudecode" | "codex" | "kiro" | "opencode";

/** The raw hook/event payload carried on the wire, in whichever harness's dialect the `harness`
 *  field names. Each strategy consumes only its own member (narrowed at the boundary by the runtime
 *  `harness` tag — see AgentStrategy's bivariance note). */
export type HarnessHookEvent =
  | ClaudeCodeHookEvent
  | CodexHookEvent
  | KiroHookEvent
  | OpenCodeForwardedEvent;

/** Adapter-injected enrichment travelling ALONGSIDE the raw `event`, never merged into it: `event`
 *  is BY DEFINITION the harness's own untouched payload (the self-describing-events invariant), so
 *  anything the plugin computes/correlates (a plan recovered from a transcript, a parent-session
 *  correlation) rides here in a separate object instead. Produced plugin-side; each field is used by
 *  exactly the harness that needs it (`planMarkdown` = Codex's transcript-recovered plan;
 *  `parentSessionId` = OpenCode's child→parent routing). NEVER part of any harness's own payload. */
export interface HarnessEventMeta {
  planMarkdown?: string;
  parentSessionId?: string;
}

/** Message type tags carried in the envelope `t` field. */
export type MessageType =
  | "hello"
  | "hello.ack"
  | "hook.event"
  | "session.attach"
  | "plan.review.request"
  | "plan.review.tool.request"
  | "plan.review.response"
  | "review.await.request"
  | "review.await.response"
  | "guided.review.await.request"
  | "guided.review.await.response"
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
  /** Adapter-injected enrichment kept OUT of `event` (see {@link HarnessEventMeta}). */
  meta?: HarnessEventMeta;
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
 *  PermissionRequest (`event.tool_input.plan`), or an OpenCode synthetic `paireto.plan.submitted`
 *  event (the plugin's own dialect). A plan the adapter had to RECOVER rides in `meta.planMarkdown`,
 *  alongside the raw `event`: Codex reads its rollout transcript, and Claude reads its own plan FILE
 *  for the common case where ExitPlanMode omits the optional `plan` argument. */
export interface PlanReviewRequest extends Envelope {
  t: "plan.review.request";
  id: string;
  harness: Harness;
  repoRoot: string;
  event: HarnessHookEvent;
  /** Adapter-injected enrichment kept OUT of `event` (see {@link HarnessEventMeta}). */
  meta?: HarnessEventMeta;
}

/**
 * A plan submitted for review through the `paireto_plan_review` MCP tool.
 *
 * Distinct from {@link PlanReviewRequest}, which is hook-shaped: a hook reports what the harness did
 * and the strategy recovers the plan from it, whereas a tool call already holds the plan and needs no
 * harness dialect to read it. Keeping them apart is what stops the tool path having to fake a hook
 * event the harness never sent.
 */
export interface PlanReviewToolRequest extends Envelope {
  t: "plan.review.tool.request";
  id: string;
  harness: Harness;
  repoRoot: string;
  cwd: string;
  /** Owning agent session, best-effort — the tool may be the first thing this agent ever sent. */
  sessionId?: string;
  /** The plan markdown to put in front of the reviewer. */
  plan: string;
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
  harness: Harness;
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

// The guided-review payload is defined in zod — see ./guidedReview.ts. Its types are re-exported
// here (type only) because the wire messages below use them, and every reader of the protocol
// expects to find the message's own field types in this file.
import type { CompareTo, GuidedChangeset } from "./guidedReview.js";
export type {
  CompareTo,
  CompareToKind,
  GuidedChangeset,
  GuidedChangesetFile,
} from "./guidedReview.js";

/**
 * Blocking guided-review session. Sent by the `paireto_start_guided_review` tool when the agent has
 * grouped the changes for a human reviewer; the extension shows the plan and holds this open until
 * the user approves or sends feedback. Flat like {@link ReviewAwaitRequest} — it comes from a tool,
 * not a hook, so it carries no raw harness `event`.
 */
export interface GuidedReviewAwaitRequest extends Envelope {
  t: "guided.review.await.request";
  id: string;
  cwd: string;
  repoRoot: string;
  /** Which harness sent this, so the extension can name (and, when new, register) its session row
   *  without a hook event to read it off. */
  harness: Harness;
  /** Owning agent session, best-effort (same fallback contract as {@link ReviewAwaitRequest}). */
  sessionId?: string;
  /** One-paragraph overview of the branch. Display only. */
  summary?: string;
  /**
   * What the agent diffed against, named with the extension's own Compare To vocabulary so the
   * window can align to it. Without this the two disagree — an agent reviewing the working tree
   * while the window compares against a merge base sees every intervening commit arrive as an
   * unclaimed change. `ref` applies to `kind: "ref"` only. Defaults to `head`.
   */
  compareTo?: CompareTo;
  changesets: GuidedChangeset[];
}

/** Extension's response to a {@link GuidedReviewAwaitRequest}; same `id`. */
export interface GuidedReviewAwaitResponse extends Envelope {
  t: "guided.review.await.response";
  id: string;
  status: ReviewStatus;
  /** Rendered review feedback (empty when approved with no comments). */
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
  /** Adapter-injected enrichment kept OUT of `event` (see {@link HarnessEventMeta}). */
  meta?: HarnessEventMeta;
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
  | PlanReviewToolRequest
  | PlanReviewResponse
  | ReviewAwaitRequest
  | ReviewAwaitResponse
  | GuidedReviewAwaitRequest
  | GuidedReviewAwaitResponse
  | StopGateRequest
  | StopGateResponse;
