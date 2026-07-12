// The HarnessDriver contract: one implementation per harness, feeding the single full-flow test whose
// steps branch on driver-declared capabilities. A driver launches its real TUI (in tmux) or server
// and plays the agent side. The test never scrapes terminals — it drives via the real paireto.gate.*
// commands + the test control plane, and asserts on the socket-observed state and the filesystem.

/** What each step must branch on — verified per-harness. */
export interface DriverCaps {
  /** Send-Feedback on a plan re-opens a fresh plan gate in VS Code (all current drivers: true). */
  planFeedbackReopens: boolean;
  /** Whether the turn-end review gate blocks the agent (claude/codex) or is post-hoc (opencode). */
  turnEndReview: "blocking" | "post-hoc";
  /** What the agent does once the plan is approved. */
  afterApprove: "auto" | "tui-select" | "agent-switch";
}

/** Everything a driver needs to launch its agent against the sandbox repo. */
export interface DriverContext {
  repoRoot: string;
  sessionId: string;
  /** Failure-artifact sink: the driver appends its wire/screen log here; screen() returns it joined. */
  log: string[];
}

export interface HarnessDriver {
  readonly harness: string;
  readonly caps: DriverCaps;
  /** false or a human-readable skip reason if this harness can't run here; true if available. */
  isAvailable(): Promise<boolean | string>;
  /** Start the agent (connect the wire / spawn the TUI). */
  launch(ctx: DriverContext): Promise<void>;
  /** Enter plan mode (harness-specific; a no-op for launch-flag harnesses). */
  enterPlanMode(): Promise<void>;
  /** Submit the initial user prompt — kicks off the plan flow. Returns once the request is in flight
   *  (it does NOT wait for the gate decision; the driver reacts to decisions on its own thereafter). */
  prompt(text: string): Promise<void>;
  /** After the plan is approved: drive whatever "start implementing" step the harness needs (codex
   *  selector, claude native-prompt fallback). */
  afterPlanApprove(): Promise<void>;
  /** Current screen / wire-log snapshot for failure artifacts. */
  screen(): Promise<string>;
  /** Tear down (kill the TUI / close the socket) and clean up any temp state. */
  dispose(): Promise<void>;
}
