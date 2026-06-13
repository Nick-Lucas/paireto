// Renders plan review comments into the deny message Claude receives. Modeled on plannotator's
// planDenyFeedback wrapper: a firm directive plus the itemized feedback. Blocking first; notes are
// omitted by default (only suggestion + blocking become action items).

import type { Severity } from "../types.js";

export interface PlanCommentData {
  line: number; // 0-based
  quote: string;
  body: string;
  severity: Severity;
}

const SEVERITY_RANK: Record<Severity, number> = { blocking: 0, suggestion: 1, note: 2 };

export function renderPlanFeedback(comments: PlanCommentData[], toolName = "ExitPlanMode"): string {
  const actionable = comments
    .filter((c) => c.severity !== "note")
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line);

  const body =
    actionable.length === 0
      ? "Plan changes requested."
      : actionable
          .map((c) => {
            const label = c.severity.toUpperCase();
            const loc = `line ${c.line + 1}`;
            const quote = c.quote.trim() ? `\n   Current text: "${c.quote.trim()}"` : "";
            return `[${label}] ${loc}${quote}\n   Feedback: ${c.body.trim()}`;
          })
          .join("\n\n");

  const counts = summarize(actionable);

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
    counts,
  ].join("\n");
}

function summarize(comments: PlanCommentData[]): string {
  const blocking = comments.filter((c) => c.severity === "blocking").length;
  const suggestion = comments.filter((c) => c.severity === "suggestion").length;
  return `(${blocking} blocking, ${suggestion} suggestion)`;
}
