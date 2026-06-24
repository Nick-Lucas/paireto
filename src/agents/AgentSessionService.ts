// Tracks Claude sessions keyed by session_id, driven purely by hook telemetry from the bridge.
// Exposes per-repo aggregate activity for the status bar. The state machine follows the real
// hook events; subagent counts move independently of the headline state.

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

/** True if an active session has gone silent long enough to be treated as idle. */
export function isStaleActive(state: AgentState, lastEventAt: number, now: number): boolean {
  return ACTIVE_STATES.has(state) && lastEventAt < now - STALE_ACTIVE_MS;
}

/** Exposed for tests. */
export const STALE_ACTIVE_MS_FOR_TEST = STALE_ACTIVE_MS;

export interface RepoActivity {
  sessionCount: number;
  subagentCount: number;
  state: AgentState;
}

export class AgentSessionService implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
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
    const now = Date.now();
    let session = this.sessions.get(msg.sessionId);
    if (!session) {
      session = {
        sessionId: msg.sessionId,
        repoRoot: msg.repoRoot,
        state: "idle",
        subagentCount: 0,
        startedAt: now,
        lastEventAt: now,
      };
      this.sessions.set(msg.sessionId, session);
    }
    session.lastEventAt = now;
    session.repoRoot = msg.repoRoot || session.repoRoot;

    const isSubagentToolEvent =
      !!msg.agentId && (msg.event === "PreToolUse" || msg.event === "PostToolUse");

    switch (msg.event) {
      case "SessionStart":
        session.state = "idle";
        break;
      case "UserPromptSubmit":
        session.state = "thinking";
        break;
      case "PreToolUse":
        if (isSubagentToolEvent) {
          break;
        }
        if (msg.toolName === "ExitPlanMode") {
          session.state = "awaitingPlanApproval";
        } else {
          session.state = "toolRunning";
          session.lastTool = msg.toolName;
        }
        break;
      case "PostToolUse":
        if (isSubagentToolEvent) {
          break;
        }
        session.state = "thinking";
        break;
      case "PermissionRequest":
        session.state = "awaitingPermission";
        break;
      case "Stop":
        session.state = "stopped";
        break;
      case "SubagentStart":
        session.subagentCount += 1;
        break;
      case "SubagentStop":
        session.subagentCount = Math.max(0, session.subagentCount - 1);
        break;
      case "SessionEnd":
        session.state = "ended";
        this.scheduleRemoval(msg.sessionId);
        break;
      case "CwdChanged":
      case "Notification":
      case "FileChanged":
      case "WorktreeCreate":
      case "WorktreeRemove":
        break;
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
      session.lastEventAt = Date.now();
      this.changeEmitter.fire();
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
    const subagentCount = sessions.reduce((n, s) => n + s.subagentCount, 0);
    const state = sessions.map((s) => s.state).sort(byPriority)[0] ?? "idle";
    return { sessionCount: sessions.length, subagentCount, state };
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
    this.sessions.clear();
    this.changeEmitter.dispose();
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
