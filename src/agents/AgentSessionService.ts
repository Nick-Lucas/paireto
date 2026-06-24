// Tracks the top-level Claude session keyed by session_id, driven purely by hook telemetry from the
// bridge. Exposes per-repo aggregate activity for the status bar. The state machine follows the real
// hook events; subagent activity is ignored entirely (we only observe the top-level agent).

import * as vscode from "vscode";

import { canonicalize } from "../protocol/paths.js";
import type { HookEventMessage } from "../protocol/types.js";
import type { AgentSession, AgentState } from "../types.js";

const ENDED_RETAIN_MS = 4000;

// Claude Code fires NO hook on user interrupt (Esc): per the docs, `Stop` does not fire on
// interrupts and there is no abort/cancel event. So a "thinking"/"toolRunning" session can be left
// spinning forever after an interrupt. We bound that with a staleness sweep: an active session with
// no telemetry for this long is downgraded to idle. It self-corrects instantly on the next event
// (UserPromptSubmit/PreToolUse/Stop), so the only cost is a brief wrong-idle during a genuinely
// silent operation longer than this window.
const STALE_ACTIVE_MS = 120_000;
const SWEEP_INTERVAL_MS = 20_000;

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
  "awaitingPlanApproval",
]);

/** True if an active session has gone silent long enough to be treated as idle. */
export function isStaleActive(state: AgentState, lastEventAt: number, now: number): boolean {
  return ACTIVE_STATES.has(state) && lastEventAt < now - STALE_ACTIVE_MS;
}

/** Exposed for tests. */
export const STALE_ACTIVE_MS_FOR_TEST = STALE_ACTIVE_MS;

export interface RepoActivity {
  sessionCount: number;
  state: AgentState;
  /** True if any session in the repo is waiting for the user (drives the orange "needs you" cue). */
  needsAttention: boolean;
}

export class AgentSessionService implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  /** Fires when a session enters a "needs you" state — drives the notification/sound. */
  private readonly finishEmitter = new vscode.EventEmitter<AgentSession>();
  readonly onDidFinish = this.finishEmitter.event;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(
    // Injectable so unit tests can simulate focus without a real window. If this window is focused
    // when an agent reaches a needs-you state, the user is already looking — no bell, no sound.
    private readonly isWindowFocused: () => boolean = () => vscode.window.state.focused,
  ) {
    this.sweepTimer = setInterval(() => this.sweepStale(), SWEEP_INTERVAL_MS);
    // Don't keep the host process alive just for the sweep.
    this.sweepTimer.unref?.();
  }

  /** Downgrade active sessions that have gone silent (e.g. after an un-hookable user interrupt). */
  private sweepStale(): void {
    const now = Date.now();
    let changed = false;
    for (const session of this.sessions.values()) {
      if (isStaleActive(session.state, session.lastEventAt, now)) {
        session.state = "idle";
        changed = true;
      }
    }
    if (changed) {
      this.changeEmitter.fire();
    }
  }

  ingest(msg: HookEventMessage): void {
    // We only observe the top-level agent session. A subagent's own events (they carry an agentId)
    // are ignored outright — they must never create, touch, change the state of, or ping for the
    // parent row.
    if (msg.agentId) {
      return;
    }
    const now = Date.now();
    let session = this.sessions.get(msg.sessionId);
    if (!session) {
      session = {
        sessionId: msg.sessionId,
        repoRoot: msg.repoRoot,
        state: "idle",
        startedAt: now,
        lastEventAt: now,
        needsAttention: false,
        changedThisTurn: false,
      };
      this.sessions.set(msg.sessionId, session);
    }
    session.lastEventAt = now;
    session.repoRoot = msg.repoRoot || session.repoRoot;
    const prevState = session.state;

    switch (msg.event) {
      case "SessionStart":
        session.state = "idle";
        break;
      case "UserPromptSubmit":
        session.state = "thinking";
        session.changedThisTurn = false; // a new turn begins — reset the "touched files" flag
        break;
      case "PreToolUse":
        if (msg.toolName === "ExitPlanMode") {
          session.state = "awaitingPlanApproval";
        } else {
          session.state = "toolRunning";
          session.lastTool = msg.toolName;
        }
        break;
      case "PostToolUse":
        if (msg.toolName && EDIT_TOOLS.has(msg.toolName)) {
          session.changedThisTurn = true;
        }
        session.state = "thinking";
        break;
      case "PermissionRequest":
        session.state = "awaitingPermission";
        break;
      case "Stop":
        session.state = "stopped";
        break;
      case "SessionEnd":
        session.state = "ended";
        this.scheduleRemoval(msg.sessionId);
        break;
      case "FileChanged":
        session.changedThisTurn = true;
        break;
      case "CwdChanged":
      case "Notification":
      case "WorktreeCreate":
      case "WorktreeRemove":
        break;
    }

    // Two things "finish" a turn (= want the user): entering a needs-you state (stopped / awaiting
    // plan / awaiting permission), and a `Notification` — Claude's own "I'm waiting for your input"
    // signal, which fires for question prompts that never reach a needs-you state (the agent just
    // parks in a tool call). Fire once on the edge: a state edge is a non-needs→needs transition; a
    // Notification edge is one that arrives while we're not already flagged (so the notification that
    // accompanies a permission prompt doesn't double-ping). Re-arm when the agent goes busy/idle
    // again so a new turn clears the marker. If the user is already looking at this window, don't
    // mark or ping at all (the bell/sound would just be noise).
    const nowNeeds = NEEDS_ATTENTION.has(session.state);
    const stateEdge = nowNeeds && !NEEDS_ATTENTION.has(prevState);
    const notificationEdge = msg.event === "Notification" && !session.needsAttention;
    if (stateEdge || notificationEdge) {
      if (!this.isWindowFocused()) {
        session.needsAttention = true;
        this.finishEmitter.fire(session);
      }
    } else if (!nowNeeds && msg.event !== "Notification") {
      // A Notification doesn't change the headline state, so don't let it clear a marker we just set.
      session.needsAttention = false;
    }

    this.changeEmitter.fire();
  }

  private scheduleRemoval(sessionId: string): void {
    setTimeout(() => {
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
    if (this.sessions.delete(sessionId)) {
      this.changeEmitter.fire();
    }
  }

  /**
   * A gated session's connection dropped (interrupt/crash) with no Stop hook to clear its state —
   * return it to idle so the Agents panel doesn't stay stuck on "awaiting plan review"/"thinking".
   * It self-corrects on the next telemetry event. No-op if the session is gone, ended, or idle.
   */
  markIdleOnDisconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session && session.state !== "ended" && session.state !== "idle") {
      session.state = "idle";
      session.needsAttention = false;
      session.lastEventAt = Date.now();
      this.changeEmitter.fire();
    }
  }

  /** The user looked at the agent (focused/switched to it) — drop its attention marker. */
  clearAttention(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.needsAttention) {
      session.needsAttention = false;
      this.changeEmitter.fire();
    }
  }

  /** True if the session touched files since its turn began (drives the Stop-gate review). */
  didChangeThisTurn(sessionId: string | undefined): boolean {
    return sessionId ? (this.sessions.get(sessionId)?.changedThisTurn ?? false) : false;
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
    const state = sessions.map((s) => s.state).sort(byPriority)[0] ?? "idle";
    const needsAttention = sessions.some((s) => s.needsAttention);
    return { sessionCount: sessions.length, state, needsAttention };
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.sessions.clear();
    this.changeEmitter.dispose();
    this.finishEmitter.dispose();
  }
}

const PRIORITY: Record<AgentState, number> = {
  awaitingPlanApproval: 0,
  awaitingPermission: 1,
  toolRunning: 2,
  thinking: 3,
  stopped: 4,
  idle: 5,
  ended: 6,
};

function byPriority(a: AgentState, b: AgentState): number {
  return PRIORITY[a] - PRIORITY[b];
}
