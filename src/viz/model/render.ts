import type { VizFile } from "../../protocol/viz.js";
import type { VizIssue } from "./types.js";

export const MAX_RENDERED_ISSUES = 30;

export function renderAccepted(viz: VizFile, issues: VizIssue[]): string {
  const counts = [
    plural(viz.nodes.length, "node"),
    plural(viz.edges?.length ?? 0, "edge"),
    plural(viz.flows?.length ?? 0, "flow"),
    plural(viz.walkthrough?.length ?? 0, "walkthrough step"),
  ].join(", ");
  const head = `Viz "${viz.title}" is open in VS Code: ${counts}.`;
  const warnings = issues.filter((issue) => issue.severity === "warning");
  if (warnings.length === 0) {
    return head;
  }
  return [
    head,
    "Warnings. Fix them in the file and call paireto_viz_present again if they matter:",
    ...renderIssues(warnings),
  ].join("\n");
}

export function renderRejected(issues: VizIssue[]): string {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const lines = [
    `Viz rejected. Fix all ${errors.length} in the file and call paireto_viz_present again. Do not remove items to pass.`,
    ...renderIssues(errors),
  ];
  if (warnings.length > 0) {
    lines.push("Warnings:", ...renderIssues(warnings));
  }
  return lines.join("\n");
}

export function renderIssue(issue: VizIssue): string {
  const hint = issue.suggestion === undefined ? "" : ` Did you mean "${issue.suggestion}"?`;
  return issue.path ? `${issue.path}: ${issue.message}${hint}` : `${issue.message}${hint}`;
}

function renderIssues(issues: VizIssue[]): string[] {
  const shown = issues.slice(0, MAX_RENDERED_ISSUES).map((issue) => `- ${renderIssue(issue)}`);
  if (issues.length > MAX_RENDERED_ISSUES) {
    shown.push(`- +${issues.length - MAX_RENDERED_ISSUES} more`);
  }
  return shown;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
