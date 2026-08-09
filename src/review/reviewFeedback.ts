// Renders code-review comments into the feedback block delivered to Claude (via additionalContext
// on the next prompt). All comments are included; problems first, then questions, then plain comments.

import dedent from "dedent";
import { join } from "node:path";
import { KIND_RANK } from "../comments/kinds.js";
import type { ReviewComment } from "./reviewTypes.js";

export function renderReviewFeedback(comments: ReviewComment[], multiRepository = false): string {
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

  // Only describe a kind of item the list actually contains — a review with no changeset comments
  // reads exactly as it always has.
  const changesetNote = actionable.some((c) => c.changeset)
    ? '\nA "Changeset" item is feedback on how you grouped the changes, not on one line of code.'
    : "";

  return dedent`
    Code review feedback received from the user:

    Address these review comments. Each item is file:line and its kind, the quoted line, and the comment.${changesetNote}

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
