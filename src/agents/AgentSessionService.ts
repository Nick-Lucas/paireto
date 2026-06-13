// Tracks Claude sessions keyed by session_id, driven purely by hook telemetry from the bridge.
// Exposes per-repo aggregate activity for the status bar. The state machine follows the real
// hook events; subagent counts move independently of the headline state.

import * as vscode from "vscode";

import { canonicalize } from "../protocol/paths.js";
import type { HookEventMessage } from "../protocol/types.js";
import type { AgentSession, AgentState } from "../types.js";

const ENDED_RETAIN_MS = 4000;

export interface RepoActivity {
  sessionCount: number;
  subagentCount: number;
  state: AgentState;
}

export class AgentSessionService implements vscode.Disposable {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

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

  /** Aggregate the busiest state for a repo (for the status-bar glyph). */
  activityForRepo(repoRoot: string): RepoActivity {
    const sessions = this.sessionsForRepo(repoRoot).filter((s) => s.state !== "ended");
    const subagentCount = sessions.reduce((n, s) => n + s.subagentCount, 0);
    const state = sessions.map((s) => s.state).sort(byPriority)[0] ?? "idle";
    return { sessionCount: sessions.length, subagentCount, state };
  }

  dispose(): void {
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
