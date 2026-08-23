// Bridge-layer types: the discovery registry and the handler interface the socket server calls
// into (kept dependency-free so the bridge doesn't import Phase 1/2/3 services directly — they
// register callbacks instead).

import type {
  GuidedReviewAwaitRequest,
  HookEventMessage,
  PlanReviewHookRequest,
  PlanReviewToolRequest,
  ReviewAwaitRequest,
  ReviewStatus,
  StopGateRequest,
} from "../protocol/types.js";

/** One row in $STATE/index.json — lets hooks discover live sockets and GC dead ones. */
export interface IndexEntry {
  repoRoot: string;
  key: string;
  socketPath: string;
  pid: number;
  windowId: string;
  startedAt: string;
  protocolVersion: number;
}

export interface IndexFile {
  version: number;
  entries: IndexEntry[];
}

export interface PlanGateResult {
  decision: "allow" | "deny";
  reason?: string;
  /** On allow: the Claude permission mode the agent should enter next (e.g. "auto"). */
  nextMode?: string;
}

export interface ReviewGateResult {
  status: ReviewStatus;
  feedback: string;
}

export interface StopGateResult {
  /** True to block the agent's turn-end (it keeps going and addresses `reason`). */
  block: boolean;
  /** Review feedback surfaced to Claude when blocking. */
  reason?: string;
}

/** A plugin turned away at the handshake because its wire version is not this window's. */
export interface HandshakeRejection {
  /** The `v` the plugin sent. */
  pluginVersion: string;
  /** The `v` this window requires. */
  extVersion: string;
  repoRoot: string;
}

/** Callbacks the socket server invokes for inbound messages. */
export interface BridgeHandlers {
  /** Passive telemetry — update session state, refresh worktrees, etc. */
  onHookEvent(msg: HookEventMessage): void;
  /**
   * Blocking plan gate — resolve when the user approves or requests changes. `signal` aborts if the
   * connection drops before a decision (the hook died / the user resolved ExitPlanMode another way),
   * so the controller can close the plan and reset its state.
   */
  onPlanReviewHook(msg: PlanReviewHookRequest, signal: AbortSignal): Promise<PlanGateResult>;
  /** A plan the AGENT submitted through the `paireto_plan_review` tool — same gate, but the plan
   *  arrives directly rather than being recovered from a hook event. */
  onPlanReviewTool(msg: PlanReviewToolRequest, signal: AbortSignal): Promise<PlanGateResult>;
  /** Manually launched review session via Skill — resolve when the user submits feedback or approves. `signal` aborts
   *  on disconnect so the controller can reset. */
  onReviewAwait(msg: ReviewAwaitRequest, signal: AbortSignal): Promise<ReviewGateResult>;
  /** Guided review — the agent submitted a changeset plan and blocks while the user works through
   *  it. Resolves like any other review: submitted with feedback, or cancelled. */
  onGuidedReviewAwait(
    msg: GuidedReviewAwaitRequest,
    signal: AbortSignal,
  ): Promise<ReviewGateResult>;
  /** Turn-end gated review session — resolve "allow" immediately unless a review is pending/in-progress for
   *  this session, in which case it holds until the user resolves the review. `signal` aborts on
   *  disconnect. */
  onStopGate(msg: StopGateRequest, signal: AbortSignal): Promise<StopGateResult>;
  /** A held-open liveness connection opened for this agent session (MCP server). */
  onSessionAttached(sessionId: string): void;
  /** A held-open liveness connection dropped. When the last one closes the process has died. */
  onSessionDetached(sessionId: string): void;
  /** A plugin was refused at the handshake. Every hook of that agent will be refused the same way
   *  until one side restarts, so this is the only chance to say so. */
  onHandshakeRejected(rejection: HandshakeRejection): void;
}
