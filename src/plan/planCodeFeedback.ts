// Lets a plan "Send Feedback" carry the comments the user left on files. Pure so the decision and
// the wording can be tested without the UI: the plan gate asks these functions what to do, then
// shows the modal itself.

import type { HarnessInstruction } from "../harness/instructions.js";
import { renderRejectedReviewFeedback } from "../review/reviewFeedback.js";
import type { ReviewComment } from "../review/reviewTypes.js";
import { renderRejectedPlanFeedback, type PlanCommentData } from "./planFeedback.js";

/** What the plan gate needs from the code-review side. ReviewController satisfies this shape. */
export interface CodeFeedbackSource {
  getComments(): ReviewComment[];
  isMultiRepository(): boolean;
  isSessionActive(): boolean;
  clearComments(): void;
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
export function composeRejectedPlanFeedback(args: {
  planComments: PlanCommentData[];
  codeComments: ReviewComment[];
  toolName: string;
  extraPlanReviewResponseInstructions?: HarnessInstruction[];
  multiRepository: boolean;
}): string {
  const plan = renderRejectedPlanFeedback(
    args.planComments,
    args.toolName,
    args.extraPlanReviewResponseInstructions,
  );
  const code = renderRejectedReviewFeedback(args.codeComments, args.multiRepository);
  if (!code) {
    return plan;
  }
  // The code block tells the agent to address the comments; say when, so it stays in plan mode.
  const bridge =
    "The user also left comments on files. Use them when you revise the plan. Do not change code yet.";
  return [plan, bridge, code].join("\n\n");
}
