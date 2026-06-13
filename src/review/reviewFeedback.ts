// Renders code-review comments into the feedback block delivered to Claude (via additionalContext
// on the next prompt). By default only unresolved suggestion + blocking comments become items.

import type { Severity } from "../types.js";
import type { ReviewComment } from "./reviewTypes.js";

const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, suggestion: 1, note: 2 };

export function renderReviewFeedback(comments: ReviewComment[]): string {
  const actionable = comments
    .filter((c) => !c.resolved && c.severity !== "note")
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.filePath.localeCompare(b.filePath) ||
        a.line - b.line,
    );

  if (actionable.length === 0) {
    return "";
  }

  const items = actionable
    .map((c) => {
      const loc = `${c.filePath}:${c.line + 1}  [${c.severity.toUpperCase()}]`;
      const quote = c.quote.trim() ? `\n> ${c.quote.trim()}` : "";
      return `${loc}${quote}\n${c.body.trim()}`;
    })
    .join("\n\n");

  return [
    `Code review feedback (${actionable.length} item${actionable.length === 1 ? "" : "s"}):`,
    "",
    "Address these review comments. Each item is file:line followed by the quoted line and the requested change.",
    "",
    items,
  ].join("\n");
}
