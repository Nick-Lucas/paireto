import type { VizArgs } from "../../protocol/viz.js";
import type { VizIssue, VizIssuePath } from "./compile.js";

export const MAX_RENDERED_ISSUES = 30;

export function renderAccepted(viz: VizArgs, warnings: VizIssue[]): string {
  const counts = [
    plural(viz.nodes.length, "node"),
    plural(viz.edges?.length ?? 0, "edge"),
    plural(viz.flows?.length ?? 0, "flow"),
    plural(viz.walkthrough?.length ?? 0, "walkthrough step"),
  ].join(", ");
  const head = `Viz "${viz.title}" is open in VS Code: ${counts}.`;
  if (warnings.length === 0) {
    return head;
  }
  return [
    head,
    "Warnings. Fix them and call paireto_show_viz again if they matter:",
    ...renderIssues(warnings),
  ].join("\n");
}

export function renderRejected(errors: VizIssue[], warnings: VizIssue[]): string {
  const lines = [
    `Viz rejected. Fix all ${errors.length} and call paireto_show_viz again. Do not remove elements to pass.`,
    ...renderIssues(errors),
  ];
  if (warnings.length > 0) {
    lines.push("Warnings:", ...renderIssues(warnings));
  }
  return lines.join("\n");
}

function formatIssuePath(path: VizIssuePath): string {
  return path
    .map((key, index) => (typeof key === "number" ? `[${key}]` : index === 0 ? key : `.${key}`))
    .join("");
}

function renderIssues(issues: VizIssue[]): string[] {
  const shown = issues.slice(0, MAX_RENDERED_ISSUES).map((issue) => {
    const where = formatIssuePath(issue.path);
    return where ? `- ${where}: ${issue.message}` : `- ${issue.message}`;
  });
  if (issues.length > MAX_RENDERED_ISSUES) {
    shown.push(`- +${issues.length - MAX_RENDERED_ISSUES} more`);
  }
  return shown;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
