// One live agent session: all per-session state and behaviour — the hook-event state machine, the
// running-subagent count, mute, the needs-you marker, and the notification gate. The owning
// AgentSessionService just manages the list of these and aggregates them; it talks back through the
// AgentSessionHost callbacks.

import { log } from "../log.js";
import { createDebouncedStop, type DebouncedStop } from "./debouncedStop.js";
import type { HookEventMessage, NotificationType } from "../protocol/types.js";
import type { AgentState } from "../types.js";

// Claude Code fires NO hook on user interrupt (Esc): per the docs, `Stop` does not fire on
// interrupts and there is no abort/cancel event. So a "thinking"/"toolRunning" session can be left
// spinning forever after an interrupt. The service bounds that with a staleness sweep: an active
// session with no telemetry for this long is downgraded to idle. It self-corrects instantly on the
// next event, so the only cost is a brief wrong-idle during a genuinely silent long operation.
const STALE_ACTIVE_MS = 120_000;

/** States that represent the agent actively working (and so can go stale after an interrupt). */
const ACTIVE_STATES: ReadonlySet<AgentState> = new Set<AgentState>(["thinking", "toolRunning"]);

/** Tools that edit files — running one marks the turn as having touched the working tree. */
const EDIT_TOOLS: ReadonlySet<string> = new Set<string>([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** States where the agent has paused and wants the user — entering one of these "finishes" a turn. */
const NEEDS_ATTENTION: ReadonlySet<AgentState> = new Set<AgentState>([
  "stopped",
  "awaitingPermission",
  "awaitingInput",
  "awaitingPlanApproval",
]);

/**
 * Map a Notification onto the state machine: its user-wanting kinds overlap the hook-driven states
 * (permission_prompt accompanies PermissionRequest, idle_prompt accompanies Stop), so rather than a
 * second ping channel they land on the state they imply and the ping stays one state-edge decision.
 * Informational kinds (auth_success, agent_completed, elicitation bookkeeping) map to nothing. A
 * MISSING type (older CLI) is treated as a generic input request, preserving the pre-filter behavior.
 */
export function stateForNotification(type: NotificationType | undefined): AgentState | undefined {
  switch (type) {
    case undefined:
    case "elicitation_dialog":
    case "agent_needs_input":
      return "awaitingInput";
    case "permission_prompt":
      return "awaitingPermission";
    case "idle_prompt":
      return "stopped";
    default:
      return undefined;
  }
}

/** True if an active session has gone silent long enough to be treated as idle. */
export function isStaleActive(state: AgentState, lastEventAt: number, now: number): boolean {
  return ACTIVE_STATES.has(state) && lastEventAt < now - STALE_ACTIVE_MS;
}

/**
 * The single notify decision: returns the human reason a needs-you notification should fire for this
 * transition, or undefined when none should. The reason IS the condition — a turn "finishes" by
 * entering a needs-you state, and only on the edge (a needs→needs move never re-pings). Callers
 * log/ping iff this returns a reason.
 */
export function shouldNotify(state: AgentState, prevState: AgentState): string | undefined {
  if (!NEEDS_ATTENTION.has(state) || NEEDS_ATTENTION.has(prevState)) {
    return undefined;
  }
  switch (state) {
    case "stopped":
      return "finished its turn (Stop)";
    case "awaitingPermission":
      return "awaiting your permission";
    case "awaitingPlanApproval":
      return "awaiting plan approval";
    case "awaitingInput":
      return "waiting for your input";
    default:
      return undefined;
  }
}

/** Exposed for tests. */
export const STALE_ACTIVE_MS_FOR_TEST = STALE_ACTIVE_MS;

/** What a session needs from its owner: window focus, emit hooks, and the settle override. */
export interface AgentSessionHost {
  /** If this window is focused the user is already looking — no bell, no sound. */
  isWindowFocused(): boolean;
  /** A needs-you ping actually fired for this session (drives the notification sound). */
  onNeedsYou(session: AgentSession): void;
  /** Something observable changed (state, marker, counters) — re-render. */
  onChanged(): void;
  /** Settle override for the stopped-edge debounce (see debouncedStop.ts; tests pass 0). */
  stopSettleMs?: number;
}

export class AgentSession {
  readonly sessionId: string;
  repoRoot: string;
  state: AgentState = "idle";
  lastTool?: string;
  readonly startedAt: number;
  lastEventAt: number;
  /** Set when the session enters a "needs you" state, until the user looks or the agent resumes. */
  needsAttention = false;
  /** True if an edit-class tool ran (or a file changed) since this turn began. */
  changedThisTurn = false;
  /** User-toggled visibility: a muted agent stays listed but never pings or joins aggregates. */
  muted = false;
  /** Running child/background agents. Gating-only: never displayed (see trackSubagent). */
  runningSubagents = 0;
  /** The timing gate every needs-you ping flows through (debounces the untrustworthy stopped edge). */
  private readonly gate: DebouncedStop;

  constructor(
    sessionId: string,
    repoRoot: string,
    private readonly host: AgentSessionHost,
  ) {
    this.sessionId = sessionId;
    this.repoRoot = repoRoot;
    this.startedAt = Date.now();
    this.lastEventAt = this.startedAt;
    this.gate = createDebouncedStop((reason) => this.fireNeedsYou(reason), host.stopSettleMs);
  }

  private get who(): string {
    return this.sessionId.slice(0, 8);
  }

  /** Apply one top-level hook event: state machine, then the single notify path. */
  applyEvent(msg: HookEventMessage): void {
    this.lastEventAt = Date.now();
    this.repoRoot = msg.repoRoot || this.repoRoot;
    const prevState = this.state;

    switch (msg.event) {
      case "SessionStart":
        this.state = "idle";
        break;
      case "UserPromptSubmit":
        this.state = "thinking";
        this.changedThisTurn = false; // a new turn begins — reset the "touched files" flag
        break;
      case "PreToolUse":
        if (msg.toolName === "ExitPlanMode") {
          this.state = "awaitingPlanApproval";
        } else {
          this.state = "toolRunning";
          this.lastTool = msg.toolName;
        }
        break;
      case "PostToolUse":
        if (msg.toolName && EDIT_TOOLS.has(msg.toolName)) {
          this.changedThisTurn = true;
        }
        this.state = "thinking";
        break;
      case "PermissionRequest":
        this.state = "awaitingPermission";
        break;
      case "Stop":
        if (this.runningSubagents > 0) {
          // Claude parked at "waiting for N background agents to finish" — it isn't done, and it
          // will emit another Stop once they all finish. Ignore this one entirely (state stays busy
          // so the real final Stop still lands on a fresh edge and pings).
          log.info(
            `stop ignored for agent ${this.who}: ${this.runningSubagents} background agents still running`,
          );
          break;
        }
        this.state = "stopped";
        break;
      case "SessionEnd":
        this.state = "ended";
        this.runningSubagents = 0;
        break;
      case "FileChanged":
        this.changedThisTurn = true;
        break;
      case "Notification": {
        const wanted = stateForNotification(msg.notificationType);
        if (wanted) {
          this.state = wanted;
        }
        break;
      }
      case "CwdChanged":
        break;
    }

    // The single notify path: every event flows through the gate exactly once — the notify decision
    // (a reason on the edge into a needs-you state) plus whether it must be debounced (only
    // "stopped": a Stop is untrustworthy at event time, so it fires only after a quiet settle
    // window). The gate calls back into fireNeedsYou, which re-validates at fire time.
    const reason = shouldNotify(this.state, prevState);
    this.gate.consider(reason, this.state === "stopped");
    if (!NEEDS_ATTENTION.has(this.state)) {
      this.needsAttention = false;
    }

    this.host.onChanged();
  }

  /** Maintain the running-subagent count; never displayed. Its only job is to recognise a Stop that
   *  isn't final ("waiting for N background agents to finish") so applyEvent can ignore it. */
  trackSubagent(msg: HookEventMessage): void {
    if (msg.event === "SubagentStart") {
      this.runningSubagents++;
    } else {
      // SubagentStop — clamp at zero (a stray stop with no matching start must never go negative).
      this.runningSubagents = Math.max(0, this.runningSubagents - 1);
    }
    // Info, not debug: the count is what gates stop pings, so unexpected pings need it in the log.
    log.info(`subagent ${msg.event} for agent ${this.who}: ${this.runningSubagents} running`);
  }

  /** Downgrade to idle if actively working but silent too long (un-hookable interrupt). The subagent
   *  count is zeroed too — telemetry has been unreliable, and a wedged count must not eat pings. */
  sweepIfStale(now: number): boolean {
    if (!isStaleActive(this.state, this.lastEventAt, now)) {
      return false;
    }
    this.state = "idle";
    this.runningSubagents = 0;
    return true;
  }

  /**
   * The session's connection dropped (interrupt/crash) with no Stop hook to clear its state — return
   * it to idle so the Agents panel doesn't stay stuck. Self-corrects on the next telemetry event.
   */
  markIdleOnDisconnect(): void {
    if (this.state === "ended" || this.state === "idle") {
      return;
    }
    this.state = "idle";
    this.needsAttention = false;
    this.runningSubagents = 0;
    this.gate.dispose(); // drop any pending stop ping
    this.lastEventAt = Date.now();
    this.host.onChanged();
  }

  /** Toggle visibility. Muting also clears any lingering attention marker so no stale bell remains. */
  setMuted(muted: boolean): void {
    if (this.muted === muted) {
      return;
    }
    this.muted = muted;
    if (muted) {
      this.needsAttention = false;
    }
    this.host.onChanged();
  }

  /** The user looked at the agent (focused/switched to it) — drop its attention marker. */
  clearAttention(): void {
    if (this.needsAttention) {
      this.needsAttention = false;
      this.host.onChanged();
    }
  }

  dispose(): void {
    this.gate.dispose();
  }

  /** The single fire path for every needs-you ping, called back by the gate (a macrotask later, or
   *  after the settle window). Re-validates first — a debounced ping's world may have moved on. */
  private fireNeedsYou(reason: string): void {
    if (!NEEDS_ATTENTION.has(this.state)) {
      return; // no longer waiting — the settle window was beaten by a state change
    }
    if (this.state === "stopped" && this.runningSubagents > 0) {
      // Subagent lifecycle events overtook the Stop on the socket — the agent will resume and emit
      // a real final Stop later. Fail quiet, but leave the tell in the log.
      log.info(
        `stop ping skipped for agent ${this.who}: ${this.runningSubagents} background agents still running`,
      );
      return;
    }
    if (this.muted) {
      // The user hid this agent — no bell, no sound. Log the suppressed edge (debug, like the
      // focus-suppression case) so an unexpected non-ping is still traceable.
      log.debug(`notification for agent ${this.who} suppressed (muted): ${reason}`);
      return;
    }
    if (this.host.isWindowFocused()) {
      log.info(`notification for agent ${this.who} suppressed (window focused): ${reason}`);
      return;
    }
    log.info(`notification for agent ${this.who}: ${reason}`);
    this.needsAttention = true;
    this.host.onNeedsYou(this);
    this.host.onChanged();
  }
}
