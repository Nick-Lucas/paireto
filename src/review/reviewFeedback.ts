// Renders code-review comments into the feedback block delivered to Claude (via additionalContext
// on the next prompt). Pending questions come before pending plain comments.

import dedent from "dedent";
import { join } from "node:path";
import { KIND_RANK } from "../comments/kinds.js";
import { userFeedback, type ReviewThread } from "./reviewTypes.js";

export function renderReviewFeedback(comments: ReviewThread[], multiRepository = false): string {
  const actionable = comments
    .filter((comment) => comment.delivery === "pending")
    .sort(
      (a, b) =>
        KIND_RANK[userFeedback(a).feedbackKind] - KIND_RANK[userFeedback(b).feedbackKind] ||
        a.repoRoot.localeCompare(b.repoRoot) ||
        a.filePath.localeCompare(b.filePath) ||
        a.line - b.line,
    );

  if (actionable.length === 0) {
    return "";
  }

  const items = actionable
    .map((c) => {
      const feedback = userFeedback(c);
      const quote = feedback.quote.trim() ? `\n> ${feedback.quote.trim()}` : "";
      return `Feedback ID: ${c.id}\n${location(c, multiRepository)}${quote}\n${feedback.body.trim()}`;
    })
    .join("\n\n");

  return dedent`
    Code review feedback received from the user:

    Address these review comments. Each item includes its feedback ID, file:line and kind, quoted line, and comment. Before you finish, call paireto_reply_to_feedback for every QUESTION and call paireto_resolve_feedback for every item after it is addressed.

    ${items}
  `;
}

/** Where a comment was left: a file:line, or the changeset whose description it sits on. */
function location(comment: ReviewThread, multiRepository: boolean): string {
  const kind = `[${userFeedback(comment).feedbackKind.toUpperCase()}]`;
  if (comment.changeset) {
    return `Changeset "${comment.changeset.title}"  ${kind}`;
  }
  const filePath = multiRepository ? join(comment.repoRoot, comment.filePath) : comment.filePath;
  return `${filePath}:${comment.line + 1}  ${kind}`;
}
