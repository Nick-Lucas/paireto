// Renders code-review feedback into the block delivered to the agent (via additionalContext on the
// next prompt). All items are included; questions first, then plain comments.

import dedent from "dedent";
import { join } from "node:path";
import { KIND_RANK } from "../comments/kinds.js";
import { getOpeningComment, type ReviewThread, type ThreadItem } from "./reviewTypes.js";

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
      return `${location(item, multiRepository)}${quote}\n${serialiseThreadItems(item)}`;
    })
    .join("\n\n");

  return dedent`
    Code review feedback received from the user:

    Address these review comments. Each item is file:line and its kind, the quoted line, and the comment.

    ${rendered}
  `;
}

function serialiseThreadItems(thread: ReviewThread): string {
  const turns = thread.items.flatMap((item) =>
    item.kind === "resolved" || !item.body.trim()
      ? []
      : [{ who: speaker(item), body: item.body.trim() }],
  );
  return turns.length > 1
    ? turns.map((turn) => `${turn.who}: ${turn.body}`).join("\n\n")
    : (turns[0]?.body ?? "");
}

function speaker(item: Exclude<ThreadItem, { kind: "resolved" }>): string {
  return item.kind === "comment" || item.author.kind === "reviewer" ? "Reviewer" : "Agent";
}

/** Where feedback was left: a file:line, or the changeset whose description it sits on. */
function location(item: ReviewThread, multiRepository: boolean): string {
  const kind = `[${getOpeningComment(item).commentKind.toUpperCase()}]`;
  if (item.changeset) {
    return `Changeset "${item.changeset.title}"  ${kind}`;
  }
  const filePath = multiRepository ? join(item.repoRoot, item.filePath) : item.filePath;
  return `${filePath}:${item.line + 1}  ${kind}`;
}
