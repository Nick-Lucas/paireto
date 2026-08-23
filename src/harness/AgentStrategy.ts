// One AgentStrategy holds ALL per-harness knowledge behind a single seam: mapping a raw hook event
// into the common AppEvent, classifying tool semantics, the human display name, the plan tool's
// user-facing wording, the default plan-approve mode, and the one-line debug rendering of a raw
// event. Everything downstream consumes only AppEvent; strategies are resolved through the
// AgentServiceLocator. Adding a harness means adding a strategy here, nothing else.

import type { HarnessEventMeta, HarnessHookEvent } from "../protocol/types.js";
import type { Harness } from "../protocol/types.js";
import type { AppEvent } from "./appEvent.js";

export interface AgentStrategy {
  readonly harness: Harness;
  /** Human name for agent rows ("Claude"). */
  readonly displayName: string;
  /** Wording for the plan tool in user-facing feedback prose (Claude: "ExitPlanMode"). */
  readonly planToolName: string;
  /** Extra rules added to REJECTED plan feedback when this harness's agent needs telling how to
   *  bring the revised plan back. Empty for harnesses whose agent re-submits on its own. An
   *  approval carries no rules: Kiro, the only harness that wants them, reads an allowed hook's
   *  stdout as a JSON decision and discards any text on it. */
  readonly rejectedPlanReviewInstructions?: string[];
  /** Whether a turn end can carry an automatic review. False for a harness whose turn-end signal is
   *  too unreliable to gate on — Kiro runs Stop hooks once per graph run, so the pass is often spent
   *  before the work is done. Those harnesses review on request only. */
  readonly supportsTurnEndReview: boolean;
  /** Default plan-approve permission mode when the user hasn't configured one; undefined = the
   *  harness has no settable mode (leave it unchanged). */
  readonly defaultPlanApproveMode: string | undefined;
  /** Whether this harness has a live process-death signal (an MCP/plugin socket the extension holds,
   *  or a SessionEnd hook). False for harnesses with neither (Codex): those can only be cleaned up
   *  by AgentSessionService's silence-based sweep-removal, so the service reads this to decide. */
  readonly supportsLiveness: boolean;
  /** Map one raw hook payload into the common representation; undefined = not relevant, drop it. A
   *  harness forwarding an event firehose keeps its relevance filter HERE, not in its plugin. `meta`
   *  carries adapter-injected enrichment kept OUT of the raw `event` (see {@link HarnessEventMeta});
   *  a strategy that needs none ignores it. */
  toAppEvent(event: HarnessHookEvent, meta?: HarnessEventMeta): AppEvent | undefined;
  /** One-line rendering of a raw inbound event for the bridge debug log (event name + context). */
  describeEvent(event: HarnessHookEvent): string;
}
