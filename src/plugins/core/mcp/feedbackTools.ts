import { z } from "zod";

import type { Harness } from "../../../protocol/types.js";
import { connect } from "../bridgeClient.js";
import type { ReviewTarget, ToolResult } from "./reviewTool.js";
import { NO_WINDOW_MESSAGE, textResult } from "./reviewTool.js";

export const FEEDBACK_REPLY_TOOL_NAME = "paireto_reply_to_feedback";
export const FEEDBACK_RESOLVE_TOOL_NAME = "paireto_resolve_feedback";

export const FEEDBACK_REPLY_TOOL_DESCRIPTION =
  "Add an agent reply to one Paireto feedback item. Use the feedback ID returned by a review.";
export const FEEDBACK_RESOLVE_TOOL_DESCRIPTION =
  "Mark one Paireto feedback item resolved after you have addressed it.";

export const FeedbackReplyArgs = z.object({
  feedbackId: z.string().trim().min(1).describe("The stable feedback ID."),
  message: z.string().trim().min(1).describe("The reply shown to the reviewer."),
});
export type FeedbackReplyArgs = z.infer<typeof FeedbackReplyArgs>;

export const FeedbackResolveArgs = z.object({
  feedbackId: z.string().trim().min(1).describe("The stable feedback ID."),
});
export type FeedbackResolveArgs = z.infer<typeof FeedbackResolveArgs>;

const CONNECT_TIMEOUT_MS = 3_000;

/** Neither mutation waits for a human, so a reply that has not arrived by now is never coming. Without
 *  a bound the agent parks for the whole life of the socket when a handler throws. */
export const MUTATION_TIMEOUT_MS = 10_000;

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

export async function runFeedbackResolve(
  target: ReviewTarget | undefined,
  harness: Harness,
  args: FeedbackResolveArgs,
  noTargetMessage = NO_WINDOW_MESSAGE,
  timeoutMs = MUTATION_TIMEOUT_MS,
): Promise<ToolResult> {
  return runMutation(
    target,
    {
      t: "feedback.resolve.request",
      repoRoot: target?.target.repoRoot ?? "",
      harness,
      sessionId: target?.sessionId,
      feedbackId: args.feedbackId,
    },
    noTargetMessage,
    timeoutMs,
  );
}

async function runMutation(
  target: ReviewTarget | undefined,
  body:
    | Omit<import("../../../protocol/types.js").FeedbackReplyRequest, "id" | "v" | "ts">
    | Omit<import("../../../protocol/types.js").FeedbackResolveRequest, "id" | "v" | "ts">,
  noTargetMessage: string,
  timeoutMs: number,
): Promise<ToolResult> {
  if (!target) {
    return textResult(noTargetMessage, true);
  }
  const connected = await connect(target.target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!connected.ok) {
    return textResult(NO_WINDOW_MESSAGE, true);
  }
  const response = await connected.connection.request(body, { timeoutMs });
  connected.connection.close();
  if (!response) {
    return textResult("The Paireto feedback request did not complete.", true);
  }
  return textResult(response.message, !response.ok);
}
