// Manages the list of live agent sessions, keyed by session_id and driven purely by hook telemetry
// from the bridge. All per-session state and behaviour lives on AgentSession; this service routes
// events to the right session, sweeps stale ones, tracks liveness attachments, and aggregates
// per-repo activity for the status bar / switcher.

import * as vscode from "vscode";

import {
  transformHarnessEventToAppEvent,
  type AppEvent,
} from "../bridge/transformHarnessEventToAppEvent.js";
import { log } from "../log.js";
import { AgentSession, type AgentSessionHost } from "./AgentSession.js";
import { NotificationService } from "../notify/NotificationService.js";
import { canonicalize } from "../protocol/paths.js";
import type { HookEventMessage } from "../protocol/types.js";
import type { AgentState } from "../types.js";

// Pure helpers re-exported for tests and co-located callers.
export {
  isStaleActive,
  shouldNotify,
  stateForNotification,
  STALE_ACTIVE_MS_FOR_TEST,
} from "./AgentSession.js";

/** How long an ended session's row lingers before it is removed from the panel. */
const ENDED_RETAIN_MS = 4000;
const SWEEP_INTERVAL_MS = 20_000;

export interface RepoActivity {
  sessionCount: number;
  state: AgentState;
  /** True if any session in the repo is waiting for the user (drives the orange "needs you" cue). */
  needsAttention: boolean;
}

/** What the Stop-gate review decision needs from a session's state — see
 *  AgentSessionService.turnState / ReviewController.awaitStopOutcome. */
export interface TurnState {
  changedThisTurn: boolean;
  /** A Task-tool subagent tracked via SubagentStart/Stop is still active, OR (Claude Code
   *  v2.1.145+) the session's latest Stop/SubagentStop reported pending background_tasks/
   *  session_crons — see AgentSession.hasPendingWork. */
  hasPendingWork: boolean;
}

export class AgentSessionService implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  /** What every session gets from this service (focus lookup, change hook, settle override). */
  private readonly host: AgentSessionHost;

  constructor(
    // Injectable so unit tests can simulate focus without a real window.
    isWindowFocused: () => boolean = () => vscode.window.state.focused,
    // Settle override for the stopped-edge ping (see debouncedStop.ts); tests pass 0.
    stopSettleMs?: number,
    // The sound player each session pings directly (injectable so tests can record calls).
    private readonly notifications: NotificationService = new NotificationService(),
  ) {
    this.host = {
      isWindowFocused,
      onChanged: () => this.changeEmitter.fire(),
      stopSettleMs,
    };
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
    // Don't keep the host process alive just for the sweep.
    this.sweepTimer.unref?.();
  }

  /** Downgrade active sessions that have gone silent (e.g. after an un-hookable user interrupt). */
  private sweepStale(): void {
    const now = Date.now();
    let anyChanged = false;
    for (const session of this.sessions.values()) {
      anyChanged = session.sweepIfStale(now) || anyChanged;
    }
    if (anyChanged) {
      this.changeEmitter.fire();
    }
  }

  ingest(msg: HookEventMessage): void {
    const event = transformHarnessEventToAppEvent(msg.harness, msg.event);

    // Subagent lifecycle events feed the running-subagent count that gates the parent's stop ping.
    // Handle them BEFORE the agentId bailout (they carry their own agent_id) — they still never
    // create a row, change headline state, or touch lastEventAt.
    if (event.kind === "subagentStart" || event.kind === "subagentStop") {
      const session = this.sessions.get(event.sessionId);
      if (!session) {
        // Never creates a parent row. Logged at info because a count that silently lands nowhere
        // means premature stop pings — this line is the tell.
        log.info(`subagent ${event.kind} ignored: unknown session ${event.sessionId.slice(0, 8)}`);
        return;
      }
      session.trackSubagent(event);
      return;
    }
    // We only observe the top-level agent session. A subagent's own events (they carry an agentId)
    // are ignored outright — they must never create, touch, change the state of, or ping for the
    // parent row. They DO count as evidence the subagent is still alive though (SubagentStart/Stop
    // don't reliably bracket its real lifetime — see AgentSession.noteSubagentActivity), so revive
    // its entry if the parent session already exists. Never creates a row.
    if (event.agentId) {
      this.sessions.get(event.sessionId)?.noteSubagentActivity(event.agentId);
      return;
    }
    let session = this.sessions.get(event.sessionId);
    if (!session) {
      session = new AgentSession(event.sessionId, msg.repoRoot, this.host, this.notifications);
      this.sessions.set(event.sessionId, session);
    }
    session.applyEvent(event, msg.repoRoot);
    if (event.kind === "sessionEnd") {
      this.scheduleRemoval(event.sessionId);
    }
  }

  private scheduleRemoval(sessionId: string): void {
    setTimeout(() => {
      this.sessions.get(sessionId)?.dispose();
      this.sessions.delete(sessionId);
      this.changeEmitter.fire();
    }, ENDED_RETAIN_MS);
  }

  sessionsForRepo(repoRoot: string): AgentSession[] {
    const target = canonicalize(repoRoot);
    return [...this.sessions.values()].filter((s) => canonicalize(s.repoRoot) === target);
  }

  /** All tracked sessions (most recently active first), for the Agents panel. */
  allSessions(): AgentSession[] {
    return [...this.sessions.values()].sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  /** Open liveness connections per session (the MCP server holds one; ref-counted so a second
   *  connection, e.g. an emulator, doesn't drop the row when only one of them closes). */
  private readonly attachCounts = new Map<string, number>();

  /** A liveness connection for this session opened (session.attach). */
  attachSession(sessionId: string): void {
    this.attachCounts.set(sessionId, (this.attachCounts.get(sessionId) ?? 0) + 1);
  }

  /** A liveness connection closed. When the last one closes, the agent's process is gone — remove it. */
  detachSession(sessionId: string): void {
    const next = (this.attachCounts.get(sessionId) ?? 0) - 1;
    if (next > 0) {
      this.attachCounts.set(sessionId, next);
      return;
    }
    this.attachCounts.delete(sessionId);
    this.removeSession(sessionId);
  }

  /**
   * Remove a session from the panel immediately (its agent process is gone — incl. SIGKILL /
   * terminal close, which fire no SessionEnd). If the agent is in fact still alive (e.g. only the MCP
   * server crashed), its next telemetry event re-creates the row.
   */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.dispose();
    if (this.sessions.delete(sessionId)) {
      this.changeEmitter.fire();
    }
  }

  /** A gated session's connection dropped (interrupt/crash) — return it to idle (see AgentSession). */
  markIdleOnDisconnect(sessionId: string): void {
    this.sessions.get(sessionId)?.markIdleOnDisconnect();
  }

  /** Toggle an agent's visibility (see AgentSession.setMuted). No-op if the session is unknown. */
  setMuted(sessionId: string, muted: boolean): void {
    this.sessions.get(sessionId)?.setMuted(muted);
  }

  /** whether the user has muted this session */
  isMuted(sessionId: string | undefined): boolean {
    if (!sessionId) {
      return false;
    }
    return this.sessions.get(sessionId)?.muted ?? false;
  }

  /** The user looked at the agent (focused/switched to it) — drop its attention marker. */
  clearAttention(sessionId: string): void {
    this.sessions.get(sessionId)?.clearAttention();
  }

  /** Everything the Stop-gate review decision needs from this session's state, in one query — see
   *  ReviewController.awaitStopOutcome. AgentSession owns both facts; this is the single place a
   *  caller reads them, rather than pulling each one separately. */
  turnState(sessionId: string | undefined): TurnState {
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    return {
      changedThisTurn: session?.changedThisTurn ?? false,
      hasPendingWork: session?.hasPendingWork ?? false,
    };
  }

  /** Record the background-task/session-cron counts from a Stop event (the blocking
   *  `stop.gate.request` path — see AgentSession.noteBackgroundWork) into the same session the
   *  passive `hook.event Stop` message updates, so both paths agree on one piece of state. */
  noteBackgroundWork(
    sessionId: string | undefined,
    event: Pick<AppEvent, "backgroundTaskCount" | "sessionCronCount">,
  ): void {
    if (sessionId) {
      this.sessions.get(sessionId)?.noteBackgroundWork(event);
    }
  }

  /** The most-recently-active non-ended session in a repo (best-effort review attribution). */
  mostRecentSessionForRepo(repoRoot: string): string | undefined {
    return this.sessionsForRepo(repoRoot)
      .filter((s) => s.state !== "ended")
      .sort((a, b) => b.lastEventAt - a.lastEventAt)[0]?.sessionId;
  }

  /** Aggregate the busiest state for a repo (for the status-bar glyph). */
  activityForRepo(repoRoot: string): RepoActivity {
    const sessions = this.sessionsForRepo(repoRoot).filter((s) => s.state !== "ended");
    // Muted agents stay listed/counted but must not drive the status bar / switcher / published
    // activity — exclude them from the busiest-state pick and the needs-you aggregate.
    const visible = sessions.filter((s) => !s.muted);
    const state = visible.map((s) => s.state).sort(byPriority)[0] ?? "idle";
    const needsAttention = visible.some((s) => s.needsAttention);
    return { sessionCount: sessions.length, state, needsAttention };
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
    this.changeEmitter.dispose();
  }
}

const PRIORITY: Record<AgentState, number> = {
  awaitingPlanApproval: 0,
  awaitingPermission: 1,
  awaitingInput: 2,
  toolRunning: 3,
  thinking: 4,
  stopped: 5,
  idle: 6,
  ended: 7,
};

function byPriority(a: AgentState, b: AgentState): number {
  return PRIORITY[a] - PRIORITY[b];
}
