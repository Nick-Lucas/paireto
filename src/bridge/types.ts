// Bridge-layer types: the discovery registry, the fail-mode config mirror, and the handler
// interface the socket server calls into (kept dependency-free so the bridge doesn't import
// Phase 1/2/3 services directly — they register callbacks instead).

import type {
  HookEventMessage,
  PlanReviewRequest,
  ReviewAwaitRequest,
  ReviewStatus,
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

/** Mirrored to $STATE/config.json so the (settings-blind) hook scripts know the policy. */
export interface BridgeConfig {
  planGate: {
    onUnavailable: "fail-open" | "fail-visible" | "deny";
    onTimeout: "fail-open" | "fail-visible" | "deny";
    onMalformed: "fail-open" | "fail-visible" | "deny";
    timeoutSeconds: number;
  };
}

export interface PlanGateResult {
  decision: "allow" | "deny";
  reason?: string;
}

export interface ReviewGateResult {
  status: ReviewStatus;
  feedback: string;
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
  /** Blocking review session — resolve when the user submits feedback or approves. `signal` aborts
   *  on disconnect so the controller can reset. */
  onReviewAwait(msg: ReviewAwaitRequest, signal: AbortSignal): Promise<ReviewGateResult>;
}
