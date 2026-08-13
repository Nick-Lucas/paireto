// Lets a plan "Send Feedback" carry the comments the user left on files. Pure so the decision and
// the wording can be tested without the UI: the plan gate asks these functions what to do, then
// shows the modal itself.

import { renderReviewFeedback } from "../review/reviewFeedback.js";
import type { ReviewThread } from "../review/reviewTypes.js";
import { renderPlanFeedback, type PlanCommentData } from "./planFeedback.js";

/** What the plan gate needs from the code-review side. ReviewController satisfies this shape. */
export interface CodeFeedbackSource {
  getPendingComments(): ReviewThread[];
  isMultiRepository(): boolean;
  isSessionActive(): boolean;
  markCommentsSent(comments: ReviewThread[]): Promise<boolean>;
}

export type PlanSendAction =
  | { action: "refuse" }
  | { action: "send" }
  | { action: "ask"; codeCount: number };

export const INCLUDE_FILE_COMMENTS = "Include Review Comments";
export const PLAN_FEEDBACK_ONLY = "Plan Comments Only";

/** Ask about file comments only when they exist and no code review owns them. */
export function planSendDecision(input: {
  planComments: number;
  codeComments: number;
  reviewInProgress: boolean;
}): PlanSendAction {
  if (input.planComments === 0) {
    return { action: "refuse" };
  }
  if (input.codeComments === 0 || input.reviewInProgress) {
    return { action: "send" };
  }
  return { action: "ask", codeCount: input.codeComments };
}

export function codeFeedbackPromptText(count: number): { message: string; detail: string } {
  const subject = count === 1 ? "the file comment" : `the ${count} file comments`;
  return {
    message: `Send ${subject} with this plan feedback?`,
    detail: "Comments you do not send will remain for the next code review.",
  };
}

/** The plan block, then the file comments when the user includes them. */
export function composePlanFeedback(args: {
  planComments: PlanCommentData[];
  codeComments: ReviewThread[];
  toolName: string;
  multiRepository: boolean;
}): string {
  const plan = renderPlanFeedback(args.planComments, args.toolName);
  const code = renderReviewFeedback(args.codeComments, args.multiRepository);
  if (!code) {
    return plan;
  }
  // The code block tells the agent to address the comments; say when, so it stays in plan mode.
  const bridge =
    "The user also left comments on files. Use them when you revise the plan. Do not change code yet.";
  return [plan, bridge, code].join("\n\n");
}
