// The HarnessDriver contract: one implementation per harness, feeding the single full-flow test whose
// steps branch on driver-declared capabilities. A driver launches its real TUI (in tmux) or server
// and plays the agent side. The test never scrapes terminals — it drives via the real paireto.gate.*
// commands + the test control plane, and asserts on the socket-observed state and the filesystem.

/** What each step must branch on — verified per-harness. */
export interface DriverCaps {
  /** Whether the turn-end review gate blocks the agent (claude/codex) or is post-hoc (opencode). */
  turnEndReview: "blocking" | "post-hoc";
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
  /** Activate the harness-specific reviewed-plan workflow. */
  enterPlanMode(): Promise<void>;
  /** Submit the initial user prompt — kicks off the plan flow. Returns once the request is in flight
   *  (it does NOT wait for the gate decision; the driver reacts to decisions on its own thereafter). */
  prompt(text: string): Promise<void>;
  /** Complete a harness-native post-approval transition that hooks cannot express. Codex uses this
   *  to select its Plan-mode approve-and-switch UI; other harnesses continue automatically. */
  afterPlanApprove?(): Promise<void>;
  /** A reason the run can no longer be trusted to mirror a user's session. Background driver watchers
   *  detect these outside the step's await chain, so the test polls this and aborts at the cause. */
  fatalError?(): string | undefined;
  /** Current screen / wire-log snapshot for failure artifacts. */
  screen(): Promise<string>;
  /** Tear down (kill the TUI / close the socket) and clean up any temp state. */
  dispose(): Promise<void>;
}
