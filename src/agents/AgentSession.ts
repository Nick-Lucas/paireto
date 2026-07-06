// One live agent session: all per-session state and behaviour — the hook-event state machine, the
// running-subagent count, mute, the needs-you marker, and the notification gate. The owning
// AgentSessionService just manages the list of these and aggregates them; it talks back through the
// AgentSessionHost callbacks.

import type { AppEvent, AppNotificationKind } from "../bridge/transformHarnessEventToAppEvent.js";
import { log } from "../log.js";
import type { AgentState } from "../types.js";
import { createDebouncedStop, type DebouncedStop } from "./debouncedStop.js";

// Claude Code fires NO hook on user interrupt (Esc): per the docs, `Stop` does not fire on
// interrupts and there is no abort/cancel event. So a "thinking"/"toolRunning" session can be left
// spinning forever after an interrupt. The service bounds that with a staleness sweep: an active
// session with no telemetry for this long is downgraded to idle. It self-corrects instantly on the
// next event, so the only cost is a brief wrong-idle during a genuinely silent long operation.
const STALE_ACTIVE_MS = 120_000;

// Backstop only, for the `activeSubagents` set specifically (see AgentSession.hasActiveSubagents).
// That set tracks the classic Task-tool subagent, where SubagentStart/Stop (and tool calls tagged
// with its agentId) DO bracket its lifetime — but not perfectly reliably: a duplicate/erroneous
// SubagentStop can arrive while it's still emitting tool activity, which `noteSubagentActivity`
// revives the moment more activity is observed. So this backstop only matters for a Task-tool
// subagent whose process died without ever emitting its real SubagentStop.
//
// Background/async agents (launched via the Agent tool in the background) are a SEPARATE case —
// they emit no SubagentStart/Stop at all, so `activeSubagents` can't see them. Those are covered by
// a different, authoritative signal instead: Claude Code v2.1.145+ includes `background_tasks`/
// `session_crons` arrays directly on the Stop/SubagentStop hook's own payload, which is real-time
// truth from Claude Code itself — no tracking/backstop needed for it at all. See
// AgentSession.hasPendingWork, which combines both signals.
const SUBAGENT_STALE_MS = 600_000;

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
 * Map a normalized Notification kind onto the state machine: user-wanting kinds overlap the
 * hook-driven states (permissionPrompt accompanies PermissionRequest, idlePrompt accompanies Stop),
 * so rather than a second ping channel they land on the state they imply and the ping stays one
 * state-edge decision. "informational" kinds map to nothing. See normalizeEvent.ts for how each
 * harness's own notification vocabulary collapses into this set.
 */
export function stateForNotification(
  kind: AppNotificationKind | undefined,
): AgentState | undefined {
  switch (kind) {
    case undefined:
    case "inputNeeded":
      return "awaitingInput";
    case "permissionPrompt":
      return "awaitingPermission";
    case "idlePrompt":
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
  /** Running child/background agents (id -> last-seen ms). Gating-only: never displayed (see
   *  trackSubagent/noteSubagentActivity). Covers the classic Task-tool subagent, whose
   *  SubagentStart/Stop bracket its lifetime. */
  private readonly activeSubagents = new Map<string, number>();
  /** `background_tasks`/`session_crons` counts from the latest Stop/SubagentStop event (Claude Code
   *  v2.1.145+ only — see noteBackgroundWork). This is the signal for async-launched subagents
   *  (Agent-tool background work), which emit NO SubagentStart/Stop of their own at all. */
  private backgroundTaskCount = 0;
  private sessionCronCount = 0;
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

  /** Apply one top-level hook event (already mapped to the common internal representation — see
   *  normalizeEvent.ts): state machine, then the single notify path. */
  applyEvent(event: AppEvent, repoRoot: string): void {
    this.lastEventAt = Date.now();
    this.repoRoot = repoRoot || this.repoRoot;
    const prevState = this.state;

    switch (event.kind) {
      case "sessionStart":
        this.state = "idle";
        break;
      case "userPromptSubmit":
        this.state = "thinking";
        this.changedThisTurn = false; // a new turn begins — reset the "touched files" flag
        break;
      case "preToolUse":
        if (event.toolName === "ExitPlanMode") {
          this.state = "awaitingPlanApproval";
        } else {
          this.state = "toolRunning";
          this.lastTool = event.toolName;
        }
        break;
      case "postToolUse":
        if (event.toolName && EDIT_TOOLS.has(event.toolName)) {
          this.changedThisTurn = true;
        }
        this.state = "thinking";
        break;
      case "permissionRequest":
        this.state = "awaitingPermission";
        break;
      case "stop":
        this.noteBackgroundWork(event);
        if (this.hasPendingWork) {
          // Claude parked waiting on background work — it isn't done, and it will emit another Stop
          // once it all finishes. Ignore this one entirely (state stays busy so the real final Stop
          // still lands on a fresh edge and pings).
          log.info(`stop ignored for agent ${this.who}: ${this.pendingWorkSummary()}`);
          break;
        }
        this.state = "stopped";
        break;
      case "sessionEnd":
        this.state = "ended";
        this.activeSubagents.clear();
        this.backgroundTaskCount = 0;
        this.sessionCronCount = 0;
        break;
      case "fileChanged":
        this.changedThisTurn = true;
        break;
      case "notification": {
        const wanted = stateForNotification(event.notificationKind);
        if (wanted) {
          this.state = wanted;
        }
        break;
      }
      case "cwdChanged":
        break;
      case "subagentStart":
      case "subagentStop":
        break; // routed to trackSubagent instead — see AgentSessionService.ingest
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

  /** True while a classic Task-tool subagent is believed active (SubagentStart/Stop bracketed it).
   *  See {@link hasPendingWork} for the combined signal that also covers background/async work. */
  get hasActiveSubagents(): boolean {
    return this.activeSubagents.size > 0;
  }

  /** True while the session is believed not really done: a Task-tool subagent is still active, OR
   *  (Claude Code v2.1.145+) the latest Stop/SubagentStop reported nonzero background_tasks/
   *  session_crons — this is what covers async-launched (Agent-tool background) subagents, which
   *  emit no SubagentStart/Stop at all. Gates the Stop guard above and the fireNeedsYou re-check
   *  below, and is what ReviewController's turn-end gate consults (AgentSessionService.turnState). */
  get hasPendingWork(): boolean {
    return this.hasActiveSubagents || this.backgroundTaskCount > 0 || this.sessionCronCount > 0;
  }

  private pendingWorkSummary(): string {
    const parts: string[] = [];
    if (this.activeSubagents.size > 0) {
      parts.push(`${this.activeSubagents.size} subagent(s)`);
    }
    if (this.backgroundTaskCount > 0) {
      parts.push(`${this.backgroundTaskCount} background task(s)`);
    }
    if (this.sessionCronCount > 0) {
      parts.push(`${this.sessionCronCount} session cron(s)`);
    }
    return parts.join(", ") || "no pending work";
  }

  /** Record the background-task/session-cron counts carried on a Stop/SubagentStop event — see
   *  hasPendingWork. Zero (older CLI versions, or a harness with no such concept) leaves
   *  hasActiveSubagents as the only signal. */
  noteBackgroundWork(
    event: Pick<AppEvent, "backgroundTaskCount" | "sessionCronCount">,
  ): void {
    this.backgroundTaskCount = event.backgroundTaskCount;
    this.sessionCronCount = event.sessionCronCount;
  }

  /** Maintain the active-subagent set; never displayed. Its only job is to recognise a Stop that
   *  isn't final ("waiting for N background agents to finish") so applyEvent can ignore it. */
  trackSubagent(event: AppEvent): void {
    if (!event.agentId) {
      return;
    }
    if (event.kind === "subagentStart") {
      this.activeSubagents.set(event.agentId, Date.now());
    } else {
      // subagentStop. A duplicate/erroneous stop can arrive while the subagent is still emitting
      // tool activity — noteSubagentActivity revives an id the moment further activity is
      // observed, so a premature stop self-corrects rather than gating the parent forever.
      this.activeSubagents.delete(event.agentId);
      // SubagentStop also carries background_tasks/session_crons (v2.1.145+) — a subagent finishing
      // is exactly when this parent-session state is worth refreshing.
      this.noteBackgroundWork(event);
    }
    // Info, not debug: the count is what gates stop pings, so unexpected pings need it in the log.
    log.info(`subagent ${event.kind} for agent ${this.who}: ${this.activeSubagents.size} running`);
  }

  /** Any other event carrying this subagent's id (e.g. its own tool calls) — evidence it's still
   *  alive even if a `SubagentStop` already (possibly prematurely) removed it. Never creates a row
   *  or touches parent state beyond this bookkeeping. */
  noteSubagentActivity(agentId: string): void {
    this.activeSubagents.set(agentId, Date.now());
  }

  /** Drop subagent entries that have gone silent too long (see SUBAGENT_STALE_MS) — a backstop for
   *  a Task-tool subagent whose process died without a `SubagentStop` ever arriving. */
  private expireStaleSubagents(now: number): boolean {
    let changed = false;
    for (const [id, lastSeen] of this.activeSubagents) {
      if (lastSeen < now - SUBAGENT_STALE_MS) {
        this.activeSubagents.delete(id);
        changed = true;
        log.info(
          `subagent ${id.slice(0, 8)} for agent ${this.who} expired after ` +
            `${SUBAGENT_STALE_MS / 1000}s of inactivity — no longer gating stop pings/reviews`,
        );
      }
    }
    return changed;
  }

  /** Downgrade to idle if actively working but silent too long (un-hookable interrupt), and expire
   *  any stale subagent entries regardless — telemetry has been unreliable, and a wedged entry must
   *  not eat pings forever. */
  sweepIfStale(now: number): boolean {
    const subagentsChanged = this.expireStaleSubagents(now);
    if (!isStaleActive(this.state, this.lastEventAt, now)) {
      return subagentsChanged;
    }
    this.state = "idle";
    this.activeSubagents.clear();
    this.backgroundTaskCount = 0;
    this.sessionCronCount = 0;
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
    this.activeSubagents.clear();
    this.backgroundTaskCount = 0;
    this.sessionCronCount = 0;
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
    if (this.state === "stopped" && this.hasPendingWork) {
      // Subagent/background-work events overtook the Stop on the socket — the agent will resume and
      // emit a real final Stop later. Fail quiet, but leave the tell in the log.
      log.info(`stop ping skipped for agent ${this.who}: ${this.pendingWorkSummary()}`);
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
