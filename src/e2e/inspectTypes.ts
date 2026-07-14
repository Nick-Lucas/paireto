// Shape of the `paireto.test.inspect` snapshot, shared between the env-gated test control plane
// (src/testControlPlane.ts, which produces it) and the E2E test (src/e2e/tests/fullflow.e2e.ts,
// which polls it). Type-only, no runtime deps, so both the host and pure-node sides can import it.

import type { AgentState } from "../types.js";
import type { Harness } from "../protocol/types.js";
import type { GateKind } from "../gate/GateCoordinator.js";

/** One live agent session as the panel sees it. */
export interface InspectSession {
  sessionId: string;
  harness: Harness;
  repoRoot: string;
  state: AgentState;
  needsAttention: boolean;
}

/** One pending gate (plan or review) with its foreground flag. */
export interface InspectGate {
  id: string;
  kind: GateKind;
  sessionId?: string;
  foreground: boolean;
}

/** The full read-only snapshot the E2E test asserts against. `planTexts` maps a plan gate id to a
 *  cheap fingerprint (`<sha1>:<length>`) so a re-proposed plan is detectable without shipping the
 *  whole markdown across the command boundary. */
export interface InspectSnapshot {
  sessions: InspectSession[];
  gates: InspectGate[];
  planTexts: Record<string, string>;
  reviewActive: boolean;
  commentBucketCount: number;
  gateHasFeedback: boolean;
}

/** Argument to the `paireto.test.addComment` command. */
export interface AddCommentArgs {
  surface: "plan" | "review";
  /** Repo-relative file path (review surface only). */
  path?: string;
  /** Absolute repository root; defaults to the active repository for single-repo tests. */
  repoRoot?: string;
  /** 0-based line to anchor on (default 0). */
  line?: number;
  kind: "question" | "comment" | "problem";
  text: string;
}
