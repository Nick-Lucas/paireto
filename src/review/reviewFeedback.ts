// Renders code-review comments into the feedback block delivered to Claude (via additionalContext
// on the next prompt). All unresolved comments are included; problems first, then questions, then
// plain comments.

import { KIND_RANK } from "../comments/kinds.js";
import type { ReviewComment } from "./reviewTypes.js";

export function renderReviewFeedback(comments: ReviewComment[]): string {
  const actionable = comments
    .filter((c) => !c.resolved)
    .sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        a.filePath.localeCompare(b.filePath) ||
        a.line - b.line
    );

  if (actionable.length === 0) {
    return "";
  }

  const items = actionable
    .map((c) => {
      const loc = `${c.filePath}:${c.line + 1}  [${c.kind.toUpperCase()}]`;
      const quote = c.quote.trim() ? `\n> ${c.quote.trim()}` : "";
      return `${loc}${quote}\n${c.body.trim()}`;
    })
    .join("\n\n");

  return [
    `Code review feedback (${actionable.length} item${actionable.length === 1 ? "" : "s"}):`,
    "",
    "Address these review comments. Each item is file:line and its kind, the quoted line, and the note.",
    "",
    items,
  ].join("\n");
}
