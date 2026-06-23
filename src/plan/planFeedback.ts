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

/** "Send Feedback": deny + a directive to revise the plan to address the feedback. */
export function renderPlanFeedback(comments: PlanCommentData[], toolName = "ExitPlanMode"): string {
  const sorted = sortComments(comments);
  return [
    "YOUR PLAN HAS FEEDBACK PROVIDED BY THE USER.",
    "",
    `Revise the plan to address the feedback below before calling ${toolName} again.`,
    "",
    "Rules:",
    "- Do not resubmit the same plan unchanged.",
    "- Do NOT change the plan title (first # heading) unless explicitly asked.",
    "- Keep the existing plan structure unless the user asks for a rewrite.",
    "",
    itemize(sorted),
    "",
    summarize(sorted),
  ].join("\n");
}

function sortComments(comments: PlanCommentData[]): PlanCommentData[] {
  return comments.slice().sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.line - b.line);
}

function itemize(sorted: PlanCommentData[]): string {
  if (sorted.length === 0) {
    return "(No line comments — see the user's message.)";
  }
  return sorted
    .map((c) => {
      const label = c.kind.toUpperCase();
      const loc = `line ${c.line + 1}`;
      const quote = c.quote.trim() ? `\n   Current text: "${c.quote.trim()}"` : "";
      return `[${label}] ${loc}${quote}\n   Feedback: ${c.body.trim()}`;
    })
    .join("\n\n");
}

function summarize(comments: PlanCommentData[]): string {
  const n = (k: CommentKind): number => comments.filter((c) => c.kind === k).length;
  return `(${n("problem")} problem, ${n("question")} question, ${n("comment")} comment)`;
}
