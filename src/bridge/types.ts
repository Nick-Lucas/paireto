// Bridge-layer types: the discovery registry and the handler interface the socket server calls
// into (kept dependency-free so the bridge doesn't import Phase 1/2/3 services directly — they
// register callbacks instead).

import type {
  HookEventMessage,
  PlanReviewRequest,
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

/** Callbacks the socket server invokes for inbound messages. */
export interface BridgeHandlers {
  /** Passive telemetry — update session state, refresh worktrees, etc. */
  onHookEvent(msg: HookEventMessage): void;
  /**
   * Blocking plan gate — resolve when the user approves or requests changes. `signal` aborts if the
   * connection drops before a decision (the hook died / the user resolved ExitPlanMode another way),
   * so the controller can close the plan and reset its state.
   */
  onPlanReviewRequest(msg: PlanReviewRequest, signal: AbortSignal): Promise<PlanGateResult>;
  /** Manually launched review session via Skill — resolve when the user submits feedback or approves. `signal` aborts
   *  on disconnect so the controller can reset. */
  onReviewAwait(msg: ReviewAwaitRequest, signal: AbortSignal): Promise<ReviewGateResult>;
  /** Turn-end gated review session — resolve "allow" immediately unless a review is pending/in-progress for
   *  this session, in which case it holds until the user resolves the review. `signal` aborts on
   *  disconnect. */
  onStopGate(msg: StopGateRequest, signal: AbortSignal): Promise<StopGateResult>;
  /** A held-open liveness connection opened for this agent session (MCP server). */
  onSessionAttached(sessionId: string): void;
  /** A held-open liveness connection dropped. When the last one closes the process has died. */
  onSessionDetached(sessionId: string): void;
}
