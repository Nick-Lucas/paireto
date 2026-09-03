// Shape of the `paireto.test.inspect` snapshot, shared between the env-gated test control plane
// (src/testControlPlane.ts, which produces it) and the E2E test (src/e2e/tests/fullflow.e2e.ts,
// which polls it). Type-only, no runtime deps, so both the host and pure-node sides can import it.

import type { AgentState, CompareTo, FileGroup } from "../types.js";
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

/** One row of the agent's review plan, as the sidebar resolved it against the live changes. */
export interface InspectGuidedFile {
  path: string;
  /** The git layer the path currently sits in; absent when it has no live change. */
  group?: FileGroup;
}

/** Titles ship whole (they are short, and the test asserts they are distinct and non-empty);
 *  descriptions ship as a length only, mirroring the `planTexts` fingerprint approach. */
export interface InspectGuidedChangeset {
  id: string;
  title: string;
  descriptionLength: number;
  files: InspectGuidedFile[];
}

export interface InspectGuided {
  repoRoot: string;
  /** The agent's changesets, plus the synthetic "Other changes" one when it has any rows. */
  changesets: InspectGuidedChangeset[];
}

/** One open review diff tab and the tree row it stands for. */
export interface InspectOpenDiff {
  path: string;
  group: string;
}

export interface InspectRepositoryChanges {
  repoRoot: string;
  compareRef: string | null;
  stagedPaths: string[];
  unstagedPaths: string[];
  committedPaths: string[];
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
  commentIds: string[];
  gateHasFeedback: boolean;
  /** Per-reason ReviewController.refresh() tally (e.g. proves openDiff never ran the full refresh). */
  refreshCounts: Record<string, number>;
  compareTo: CompareTo;
  /** Which tree row each open diff tab stands for — a tab that outlives its row is a stale record. */
  openDiffs: InspectOpenDiff[];
  repositories: InspectRepositoryChanges[];
  /** Present only while a guided review is open. */
  guided?: InspectGuided;
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
  reply?: boolean;
  kind: "question" | "comment";
  text: string;
}
