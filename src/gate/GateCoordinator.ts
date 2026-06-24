// Coordinates the gate surfaces (Plan Review + Code Review) across potentially several concurrently
// PENDING agents. Only ONE gate is *foreground* at a time — it occupies the editor/comment surfaces
// and is the target of the shared Approve / Send-Feedback commands — but multiple may be pending
// (their agents blocked on the socket). The user switches the foreground by clicking an agent; the
// backgrounded gate is hidden, NOT resolved, and can be returned to. The integrated terminal panel
// is hidden while the foreground gate is a plan and restored otherwise.

import * as vscode from "vscode";

import { hideBottomPanel, showTerminalPanel } from "./tabs.js";

export type GateKind = "plan" | "review";

/** The active flow behind the shared Approve / Send-Feedback commands. */
export interface GateSession {
  readonly kind: GateKind;
  approve(): void | Promise<void>;
  sendFeedback(): void | Promise<void>;
  /** True when there's ≥1 actionable comment queued (drives which gate button shows). */
  hasFeedback(): boolean;
}

/** A pending gate: its identity, the agent that owns it, and how to show/hide its UI. */
export interface GateEntry {
  readonly id: string;
  /** Owning agent session (plans always; reviews best-effort). */
  readonly sessionId?: string;
  readonly kind: GateKind;
  readonly repoRoot: string;
  readonly session: GateSession;
  /** Show this gate's UI (open its plan tab / activate its review). */
  foreground(): void | Promise<void>;
  /** Hide this gate's UI WITHOUT resolving it (close its tab / deactivate its review). */
  background(): void | Promise<void>;
}

export class GateCoordinator implements vscode.Disposable {
  private readonly entries: GateEntry[] = [];
  private foregroundId?: string;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever the set of pending gates or the foreground changes (drives the Agents panel). */
  readonly onDidChange = this.changeEmitter.event;
  /** True while we've hidden the bottom panel for a foreground gate (so we only restore our own). */
  private panelHidden = false;

  constructor(
    // Injectable so unit tests can run without touching the real VS Code panel.
    private readonly hidePanel: () => Promise<void> | void = hideBottomPanel,
    private readonly showPanel: () => Promise<void> | void = showTerminalPanel,
  ) {}

  /** The foreground gate's session (target of the shared Approve / Send-Feedback commands). */
  get current(): GateSession | undefined {
    return this.foregroundEntry?.session;
  }

  get foregroundEntry(): GateEntry | undefined {
    return this.entries.find((e) => e.id === this.foregroundId);
  }

  isActive(): boolean {
    return this.foregroundId !== undefined;
  }

  isForeground(id: string): boolean {
    return this.foregroundId === id;
  }

  entriesForRepo(repoRoot: string): GateEntry[] {
    return this.entries.filter((e) => e.repoRoot === repoRoot);
  }

  /** The pending gate owned by an agent session, if any. */
  entryForSession(sessionId: string): GateEntry | undefined {
    return this.entries.find((e) => e.sessionId === sessionId);
  }

  /** Register a newly-pending gate. Foregrounds it only if nothing else is foreground. */
  async register(entry: GateEntry): Promise<void> {
    this.entries.push(entry);
    if (this.foregroundId === undefined) {
      await this.setForeground(entry.id);
    }
    this.changeEmitter.fire();
  }

  /** Remove a resolved gate. If it was foreground, promote the most-recent remaining gate. */
  async unregister(id: string): Promise<void> {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx === -1) {
      return;
    }
    this.entries.splice(idx, 1);
    if (this.foregroundId === id) {
      this.foregroundId = undefined;
      const next = this.entries[this.entries.length - 1];
      if (next) {
        await this.setForeground(next.id);
      } else {
        await this.applyPanel(undefined);
      }
    }
    this.changeEmitter.fire();
  }

  /** Switch the foreground to a pending gate (backgrounding the current one, without resolving it). */
  async switchTo(id: string): Promise<void> {
    if (this.foregroundId === id || !this.entries.some((e) => e.id === id)) {
      return;
    }
    await this.setForeground(id);
    this.changeEmitter.fire();
  }

  private async setForeground(id: string): Promise<void> {
    const prev = this.foregroundEntry;
    if (prev && prev.id !== id) {
      await prev.background();
    }
    this.foregroundId = id;
    const next = this.foregroundEntry;
    if (next) {
      await next.foreground();
      await this.applyPanel(next.kind);
    }
  }

  /** Hide the bottom panel while any gate (plan or review) is foreground; restore it when none is. */
  private async applyPanel(kind: GateKind | undefined): Promise<void> {
    try {
      if (kind !== undefined) {
        if (!this.panelHidden) {
          this.panelHidden = true;
          await this.hidePanel();
        }
      } else if (this.panelHidden) {
        this.panelHidden = false;
        await this.showPanel();
      }
    } catch {
      /* panel commands are best-effort */
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
