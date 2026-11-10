import { z } from "zod";

import type { Harness } from "../../../protocol/types.js";
import { MUTATION_TIMEOUT_MS, runMutation } from "./mutation.js";
import type { ReviewTarget, ToolResult } from "./reviewTool.js";
import { NO_WINDOW_MESSAGE } from "./reviewTool.js";

export const FEEDBACK_REPLY_TOOL_NAME = "paireto_reply_to_feedback";

export const FEEDBACK_REPLY_TOOL_DESCRIPTION =
  "Answer one Paireto review question. Use the feedback ID returned by a review. Do not use this " +
  "for a comment: make the code changes the comment asks for and do not reply.";

export const FeedbackReplyArgs = z.object({
  feedbackId: z.string().trim().min(1).describe("The stable feedback ID."),
  message: z.string().trim().min(1).describe("The reply shown to the reviewer."),
});
export type FeedbackReplyArgs = z.infer<typeof FeedbackReplyArgs>;

export async function runFeedbackReply(
  target: ReviewTarget | undefined,
  harness: Harness,
  args: FeedbackReplyArgs,
  noTargetMessage = NO_WINDOW_MESSAGE,
  timeoutMs = MUTATION_TIMEOUT_MS,
): Promise<ToolResult> {
  return runMutation(
    target,
    {
      t: "feedback.reply.request",
      repoRoot: target?.target.repoRoot ?? "",
      harness,
      sessionId: target?.sessionId,
      feedbackId: args.feedbackId,
      message: args.message,
    },
    noTargetMessage,
    timeoutMs,
  );
}
