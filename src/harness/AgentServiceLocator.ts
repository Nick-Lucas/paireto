// The registry of AgentStrategies. Constructed once in activate() with no arguments — it hard-codes
// the one strategy per known harness internally (the Harness union is closed, so there is nothing to
// inject). Injected into the bridge boundary (transform + describeEvent), PlanReviewController
// (plan-approve mode), AgentSessionService (per-session supportsLiveness stamp), and MainTreeProvider
// (display name). strategyFor is total over the closed Harness union; strategyForWire tolerates
// unvalidated wire strings (e.g. an unrecognized plugin) for logging.

import type { Harness } from "../protocol/types.js";
import type { AgentStrategy } from "./AgentStrategy.js";
import { ClaudeCodeStrategy } from "./ClaudeCodeStrategy.js";
import { CodexStrategy } from "./CodexStrategy.js";
import { OpenCodeStrategy } from "./OpenCodeStrategy.js";

export class AgentServiceLocator {
  // One entry per Harness — the literal map is the single point that knows the full set of harnesses.
  private readonly byHarness: ReadonlyMap<Harness, AgentStrategy> = new Map<Harness, AgentStrategy>([
    ["claudecode", new ClaudeCodeStrategy()],
    ["codex", new CodexStrategy()],
    ["opencode", new OpenCodeStrategy()],
  ]);

  /** Resolve the strategy for a validated harness. Total over the closed union — a missing entry is
   *  a wiring bug (a Harness value with no registered strategy), so throw rather than fail silently. */
  strategyFor(harness: Harness): AgentStrategy {
    const strategy = this.byHarness.get(harness);
    if (!strategy) {
      throw new Error(`No agent strategy registered for harness "${harness}"`);
    }
    return strategy;
  }

  /** Resolve from an unvalidated wire string (an inbound message's harness field). Returns undefined
   *  for an unrecognized harness so callers (logging) can fall back gracefully. */
  strategyForWire(name: string): AgentStrategy | undefined {
    return this.byHarness.get(name as Harness);
  }
}
