// Renders plan review comments into the deny message Claude receives. Modeled on plannotator's
// planDenyFeedback wrapper: a firm directive plus the itemized feedback. Problems first, then
// questions, then plain comments — all kinds are included.

import { KIND_RANK, type CommentKind } from "../comments/kinds.js";

export interface PlanCommentData {
  line: number; // 0-based
  quote: string;
  body: string;
  kind: CommentKind;
}

export function renderPlanFeedback(comments: PlanCommentData[], toolName = "ExitPlanMode"): string {
  const sorted = comments
    .slice()
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.line - b.line);

  const body =
    sorted.length === 0
      ? "Plan changes requested."
      : sorted
          .map((c) => {
            const label = c.kind.toUpperCase();
            const loc = `line ${c.line + 1}`;
            const quote = c.quote.trim() ? `\n   Current text: "${c.quote.trim()}"` : "";
            return `[${label}] ${loc}${quote}\n   Feedback: ${c.body.trim()}`;
          })
          .join("\n\n");

  return [
    "YOUR PLAN WAS NOT APPROVED.",
    "",
    `You MUST revise the plan to address ALL of the feedback below before calling ${toolName} again.`,
    "",
    "Rules:",
    "- Do not resubmit the same plan unchanged.",
    "- Do NOT change the plan title (first # heading) unless explicitly asked.",
    "- Keep the existing plan structure unless a comment asks for a rewrite.",
    "",
    body,
    "",
    summarize(sorted),
  ].join("\n");
}

function summarize(comments: PlanCommentData[]): string {
  const n = (k: CommentKind): number => comments.filter((c) => c.kind === k).length;
  return `(${n("problem")} problem, ${n("question")} question, ${n("comment")} comment)`;
}
