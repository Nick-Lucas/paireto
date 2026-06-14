// The single TUI Companion sidebar view. Top-level rows are collapsible section headers — Agents,
// Plan Review, Changed Files, Feedback — and their children are the items. Sections appear by state:
// Agents always; Plan Review while a plan is pending; Changed Files + Feedback during a /tui-review
// session. Section-scoped actions live as inline buttons on the section header rows (see package.json
// view/item/context, keyed on the `section:<id>` contextValue).

import * as path from "node:path";

import * as vscode from "vscode";

import type { AgentSessionService } from "../agents/AgentSessionService.js";
import { kindColorId, kindIcon, kindLabel } from "../comments/kinds.js";
import { Commands } from "../config.js";
import type { ChangedFile } from "../git/DiffService.js";
import type { PlanReviewController } from "../plan/PlanReviewController.js";
import type { PlanCommentData } from "../plan/planFeedback.js";
import { ReviewFileDecorationProvider } from "../review/ReviewFileDecorationProvider.js";
import type { ReviewController } from "../review/ReviewController.js";
import type { ReviewComment } from "../review/reviewTypes.js";
import type { AgentSession, AgentState, ReviewMode, ReviewSpec } from "../types.js";

type SectionId = "agents" | "plan" | "files" | "feedback";

type Node =
  | { kind: "section"; id: SectionId; label: string; description?: string }
  | { kind: "agent"; session: AgentSession }
  | { kind: "file"; file: ChangedFile }
  | { kind: "reviewComment"; comment: ReviewComment }
  | { kind: "planComment"; comment: PlanCommentData }
  | { kind: "placeholder"; label: string };

const MODE_LABELS: Record<ReviewMode, string> = {
  unstaged: "Unstaged",
  staged: "Staged",
  uncommitted: "Uncommitted",
  branch: "Branch",
  commitRange: "Commit range",
};

const STATE_LABEL: Record<AgentState, string> = {
  idle: "idle",
  thinking: "thinking",
  toolRunning: "running tool",
  awaitingPlanApproval: "awaiting plan review",
  awaitingPermission: "awaiting permission",
  stopped: "stopped",
  ended: "ended",
};

const STATE_ICON: Record<AgentState, string> = {
  idle: "circle-outline",
  thinking: "loading~spin",
  toolRunning: "tools",
  awaitingPlanApproval: "comment-discussion",
  awaitingPermission: "warning",
  stopped: "primitive-square",
  ended: "circle-slash",
};

function reviewSummary(spec: ReviewSpec): string {
  const base =
    spec.mode === "branch" || spec.mode === "commitRange" ? ` · ${spec.baseRef ?? "—"}` : "";
  return `${MODE_LABELS[spec.mode]}${base}`;
}

function statusWord(s: ChangedFile["status"]): string {
  return { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", U: "Untracked" }[s];
}

export class MainTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly agents: AgentSessionService,
    private readonly review: ReviewController,
    private readonly plan: PlanReviewController
  ) {
    const fire = (): void => this.emitter.fire();
    this.subs.push(
      this.agents.onDidChange(fire),
      this.review.onDidChangeState(fire),
      this.plan.onDidChange(fire)
    );
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "section": {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.contextValue = `section:${node.id}`;
        item.description = node.description;
        return item;
      }
      case "agent":
        return agentItem(node.session);
      case "file":
        return fileItem(node.file);
      case "reviewComment":
        return reviewCommentItem(node.comment);
      case "planComment":
        return planCommentItem(node.comment);
      case "placeholder": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.contextValue = "placeholder";
        return item;
      }
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.sections();
    }
    if (node.kind !== "section") {
      return [];
    }
    switch (node.id) {
      case "agents": {
        const sessions = this.agents.allSessions().filter((s) => s.state !== "ended");
        return sessions.length
          ? sessions.map((session) => ({ kind: "agent", session }) as Node)
          : [placeholder("No agents connected")];
      }
      case "plan": {
        const comments = this.plan.getComments();
        return comments.length
          ? comments.map((comment) => ({ kind: "planComment", comment }) as Node)
          : [placeholder("No comments — Approve, or add feedback on the plan")];
      }
      case "files": {
        const files = this.review.getState().files;
        return files.length
          ? files.map((file) => ({ kind: "file", file }) as Node)
          : [placeholder("No changes for this review mode")];
      }
      case "feedback": {
        const comments = this.review.getComments();
        return comments.length
          ? comments.map((comment) => ({ kind: "reviewComment", comment }) as Node)
          : [placeholder("No comments yet — add them on the diff")];
      }
    }
  }

  private sections(): Node[] {
    const out: Node[] = [];
    const agentCount = this.agents.allSessions().filter((s) => s.state !== "ended").length;
    out.push({ kind: "section", id: "agents", label: "Agents", description: count(agentCount) });

    // Changed Files is always available for browsing the working diff.
    out.push({
      kind: "section",
      id: "files",
      label: "Changed Files",
      description: reviewSummary(this.review.getState().spec),
    });

    // Plan + Feedback only appear during their respective review flows.
    if (this.plan.hasPendingPlan()) {
      out.push({ kind: "section", id: "plan", label: "Plan Review" });
    }
    if (this.review.isSessionActive()) {
      out.push({
        kind: "section",
        id: "feedback",
        label: "Feedback",
        description: count(this.review.getComments().length),
      });
    }
    return out;
  }

  dispose(): void {
    for (const d of this.subs) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

function count(n: number): string | undefined {
  return n > 0 ? String(n) : undefined;
}

function placeholder(label: string): Node {
  return { kind: "placeholder", label };
}

function agentItem(s: AgentSession): vscode.TreeItem {
  const item = new vscode.TreeItem(path.basename(s.repoRoot), vscode.TreeItemCollapsibleState.None);
  const subs = s.subagentCount > 0 ? ` · ${s.subagentCount} sub` : "";
  item.description = `${STATE_LABEL[s.state]}${subs}`;
  item.iconPath = new vscode.ThemeIcon(STATE_ICON[s.state]);
  item.tooltip = `${s.repoRoot}\nSession ${s.sessionId}\n${STATE_LABEL[s.state]}`;
  item.contextValue = "agentSession";
  return item;
}

function fileItem(file: ChangedFile): vscode.TreeItem {
  const item = new vscode.TreeItem(
    ReviewFileDecorationProvider.fileUri(file.path, file.status),
    vscode.TreeItemCollapsibleState.None
  );
  const dir = path.dirname(file.path);
  const counts = `+${file.additions} -${file.deletions}`;
  item.description = dir === "." ? counts : `${dir}  ${counts}`;
  item.tooltip = `${file.path}\n${statusWord(file.status)} · ${counts}`;
  item.contextValue = "changedFile";
  item.command = { command: Commands.reviewOpenDiff, title: "Open Diff", arguments: [file] };
  return item;
}

function reviewCommentItem(c: ReviewComment): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `${path.basename(c.filePath)}:${c.line + 1}`,
    vscode.TreeItemCollapsibleState.None
  );
  const dir = path.dirname(c.filePath);
  item.description = dir === "." ? c.body : `${dir} · ${c.body}`;
  item.iconPath = kindThemeIcon(c.kind);
  item.tooltip = new vscode.MarkdownString(
    `**${kindLabel(c.kind)}** · ${c.filePath}:${c.line + 1}\n\n> ${c.quote}\n\n${c.body}`
  );
  item.contextValue = "reviewComment";
  item.command = { command: Commands.reviewRevealComment, title: "Reveal Comment", arguments: [c] };
  return item;
}

function planCommentItem(c: PlanCommentData): vscode.TreeItem {
  const item = new vscode.TreeItem(`Line ${c.line + 1}`, vscode.TreeItemCollapsibleState.None);
  item.description = c.body;
  item.iconPath = kindThemeIcon(c.kind);
  item.tooltip = new vscode.MarkdownString(
    `**${kindLabel(c.kind)}** · line ${c.line + 1}\n\n> ${c.quote}\n\n${c.body}`
  );
  item.contextValue = "planComment";
  return item;
}

function kindThemeIcon(kind: ReviewComment["kind"]): vscode.ThemeIcon {
  const colorId = kindColorId(kind);
  return new vscode.ThemeIcon(kindIcon(kind), colorId ? new vscode.ThemeColor(colorId) : undefined);
}
