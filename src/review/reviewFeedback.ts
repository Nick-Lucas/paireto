// Renders code-review comments into the feedback block delivered to Claude (via additionalContext
// on the next prompt). All comments are included; problems first, then questions, then plain comments.

import dedent from "dedent";
import { join } from "node:path";
import { KIND_RANK } from "../comments/kinds.js";
import type { ReviewComment } from "./reviewTypes.js";

export function renderRejectedReviewFeedback(
  comments: ReviewComment[],
  multiRepository = false,
): string {
  const actionable = [...comments].sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.repoRoot.localeCompare(b.repoRoot) ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line,
  );

  if (actionable.length === 0) {
    return "";
  }

  const items = actionable
    .map((c) => {
      const quote = c.quote.trim() ? `\n> ${c.quote.trim()}` : "";
      return `${location(c, multiRepository)}${quote}\n${c.body.trim()}`;
    })
    .join("\n\n");

  return dedent`
    Code review feedback received from the user:

    Address these review comments. Each item is file:line and its kind, the quoted line, and the comment.

    ${items}
  `;
}

/** Where a comment was left: a file:line, or the changeset whose description it sits on. */
function location(comment: ReviewComment, multiRepository: boolean): string {
  const kind = `[${comment.kind.toUpperCase()}]`;
  if (comment.changeset) {
    return `Changeset "${comment.changeset.title}"  ${kind}`;
  }
  const filePath = multiRepository ? join(comment.repoRoot, comment.filePath) : comment.filePath;
  return `${filePath}:${comment.line + 1}  ${kind}`;
}
