// The single TUI Companion sidebar view. Top-level rows are collapsible section headers — Agents,
// Plan Review, Changed Files, Feedback. The Changed Files section nests group headers (Staged /
// Unstaged / Committed), each laid out flat or as a compressed folder tree. Section/group/file
// actions are inline buttons (see package.json view/item/context, keyed on contextValue).

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
import type { AgentSession, AgentState, FileGroup } from "../types.js";
import { buildFileTree, type TreeEntry } from "./fileTree.js";

type SectionId = "agents" | "plan" | "files" | "feedback";

type Node =
  | { kind: "section"; id: SectionId; label: string; description?: string }
  | { kind: "group"; group: FileGroup; label: string; count: number }
  | { kind: "folder"; entry: Extract<TreeEntry, { type: "folder" }> }
  | { kind: "file"; file: ChangedFile }
  | { kind: "agent"; session: AgentSession }
  | { kind: "reviewComment"; comment: ReviewComment }
  | { kind: "planComment"; comment: PlanCommentData }
  | { kind: "placeholder"; label: string };

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
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = `section:${node.id}`;
        item.description = node.description;
        return item;
      }
      case "group": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
        item.contextValue = `group:${node.group}`;
        item.description = String(node.count);
        return item;
      }
      case "folder": {
        const item = new vscode.TreeItem(node.entry.name, vscode.TreeItemCollapsibleState.Expanded);
        item.resourceUri = vscode.Uri.file(node.entry.path);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = "folder";
        return item;
      }
      case "file":
        return fileItem(node.file);
      case "agent":
        return agentItem(node.session);
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
    switch (node.kind) {
      case "section":
        return this.sectionChildren(node.id);
      case "group":
        return this.groupChildren(node.group);
      case "folder":
        return node.entry.children.map((e) => entryToNode(e));
      default:
        return [];
    }
  }

  private sections(): Node[] {
    const out: Node[] = [];
    const agentCount = this.agents.allSessions().filter((s) => s.state !== "ended").length;
    out.push({ kind: "section", id: "agents", label: "Agents", description: count(agentCount) });

    out.push({
      kind: "section",
      id: "files",
      label: "Changed Files",
      description: this.review.getState().changes.compareLabel,
    });

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

  private sectionChildren(id: SectionId): Node[] {
    switch (id) {
      case "agents": {
        const sessions = this.agents.allSessions().filter((s) => s.state !== "ended");
        return sessions.length
          ? sessions.map((session) => ({ kind: "agent", session }) as Node)
          : [placeholder("No agents connected")];
      }
      case "files": {
        const { staged, unstaged, committed } = this.review.getState().changes;
        const groups: Node[] = [];
        if (staged.length) {
          groups.push({ kind: "group", group: "staged", label: "Staged", count: staged.length });
        }
        if (unstaged.length) {
          groups.push({
            kind: "group",
            group: "unstaged",
            label: "Unstaged",
            count: unstaged.length,
          });
        }
        if (committed.length) {
          groups.push({
            kind: "group",
            group: "committed",
            label: "Committed",
            count: committed.length,
          });
        }
        return groups.length ? groups : [placeholder("No changes")];
      }
      case "plan": {
        const comments = this.plan.getComments();
        return comments.length
          ? comments.map((comment) => ({ kind: "planComment", comment }) as Node)
          : [placeholder("No comments — Approve, or add feedback on the plan")];
      }
      case "feedback": {
        const comments = this.review.getComments();
        return comments.length
          ? comments.map((comment) => ({ kind: "reviewComment", comment }) as Node)
          : [placeholder("No comments yet — add them on the diff")];
      }
    }
  }

  private groupChildren(group: FileGroup): Node[] {
    const { changes, layout } = this.review.getState();
    const files = changes[group];
    if (layout === "flat") {
      return files.map((file) => ({ kind: "file", file }) as Node);
    }
    return buildFileTree(files).map((e) => entryToNode(e));
  }

  dispose(): void {
    for (const d of this.subs) {
      d.dispose();
    }
    this.emitter.dispose();
  }
}

function entryToNode(entry: TreeEntry): Node {
  return entry.type === "folder" ? { kind: "folder", entry } : { kind: "file", file: entry.file };
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
  item.label = path.basename(file.path);
  const dir = path.dirname(file.path);
  const counts = `+${file.additions} -${file.deletions}`;
  item.description = dir === "." ? counts : `${dir}  ${counts}`;
  item.tooltip = `${file.path}\n${statusWord(file.status)} · ${counts}`;
  item.contextValue = `changedFile:${file.group}`;
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
