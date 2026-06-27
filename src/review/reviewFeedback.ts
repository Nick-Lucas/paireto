// Renders code-review comments into the feedback block delivered to Claude (via additionalContext
// on the next prompt). All comments are included; problems first, then questions, then plain comments.

import dedent from "dedent";
import { KIND_RANK } from "../comments/kinds.js";
import type { ReviewComment } from "./reviewTypes.js";

export function renderReviewFeedback(comments: ReviewComment[]): string {
  const actionable = [...comments].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line,
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

  return dedent`
    Code review feedback received from the user:

    Address these review comments. Each item is file:line and its kind, the quoted line, and the comment.

    ${items}
  `;
}
