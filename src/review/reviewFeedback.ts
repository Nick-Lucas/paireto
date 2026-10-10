// Renders code-review feedback into the block delivered to the agent (via additionalContext on the
// next prompt). All items are included; questions first, then plain comments.

import dedent from "dedent";
import { join } from "node:path";
import { KIND_RANK } from "../comments/kinds.js";
import { serialiseConversation } from "../comments/threadModel.js";
import { getOpeningComment, type ReviewThread } from "./reviewTypes.js";

export function serialiseRejectedReviewFeedback(
  items: ReviewThread[],
  multiRepository = false,
): string {
  const actionable = [...items].sort(
    (a, b) =>
      KIND_RANK[getOpeningComment(a).commentKind] - KIND_RANK[getOpeningComment(b).commentKind] ||
      a.repoRoot.localeCompare(b.repoRoot) ||
      a.filePath.localeCompare(b.filePath) ||
      a.line - b.line,
  );

  if (actionable.length === 0) {
    return "";
  }

  const rendered = actionable
    .map((item) => {
      const feedback = getOpeningComment(item);
      const quote = feedback.quote.trim() ? `\n> ${feedback.quote.trim()}` : "";
      return `Feedback ID: ${item.id}\n${location(item, multiRepository)}${quote}\n${serialiseConversation(item)}`;
    })
    .join("\n\n");

  return dedent`
    Code review feedback received from the user:

    Each item includes its feedback ID, file:line and kind, quoted line, and comment. Act on each item by its kind:
    - [QUESTION]: answer it with paireto_reply_to_feedback. Do not change code for a question.
    - [COMMENT]: make the code changes it asks for. Do not reply to a comment.
    The reviewer closes each item themselves.

    ${rendered}
  `;
}

function location(item: ReviewThread, multiRepository: boolean): string {
  const kind = `[${getOpeningComment(item).commentKind.toUpperCase()}]`;
  if (item.changeset) {
    return `Changeset "${item.changeset.title}"  ${kind}`;
  }
  const filePath = multiRepository ? join(item.repoRoot, item.filePath) : item.filePath;
  return `${filePath}:${item.line + 1}  ${kind}`;
}
