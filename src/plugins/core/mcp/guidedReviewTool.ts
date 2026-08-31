// The `paireto_start_guided_review` tool: one definition, shared by every harness's MCP server.
//
// Like `paireto_review`, the name and description are part of the agent-facing contract — the model
// decides whether to call this from the description alone, and the e2e replay fixtures match on the
// whole tool inventory — so treat the text and the schema as fixed rather than reworded freely.

import type { GuidedReviewArgs } from "../../../protocol/guidedReview.js";
import type { Harness } from "../../../protocol/types.js";
import { connect } from "../bridgeClient.js";
import type { ReviewTarget, ToolResult } from "./reviewTool.js";
import { connectFailureMessage, NO_WINDOW_MESSAGE, textResult } from "./reviewTool.js";

export const GUIDED_REVIEW_TOOL_NAME = "paireto_start_guided_review";

export const GUIDED_REVIEW_TOOL_DESCRIPTION =
  "Hand a review plan to the human reviewer and wait for feedback. Blocks until they respond.";

const CONNECT_TIMEOUT_MS = 3000;

/**
 * Hand the plan over and block until the reviewer resolves it. Same lifetime and failure modes as
 * {@link runReview} — the reviewer works through the plan for as long as they like, and the MCP
 * client's own tool timeout is the outer bound.
 */
export async function runGuidedReview(
  reviewTarget: ReviewTarget | undefined,
  harness: Harness,
  args: GuidedReviewArgs,
  noTargetMessage: string = NO_WINDOW_MESSAGE,
): Promise<ToolResult> {
  if (!reviewTarget) {
    return textResult(noTargetMessage, true);
  }

  const result = await connect(reviewTarget.target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    return textResult(connectFailureMessage(result.reason, result.extVersion), true);
  }

  const response = await result.connection.request({
    t: "guided.review.await.request",
    cwd: reviewTarget.cwd,
    repoRoot: reviewTarget.target.repoRoot,
    harness,
    sessionId: reviewTarget.sessionId,
    summary: args.summary,
    compareTo: args.compareTo,
    changesets: args.changesets ?? [],
  });
  result.connection.close();

  if (!response) {
    return textResult("Review plan closed.");
  }
  if (response.status === "submitted" && response.feedback) {
    return textResult(response.feedback);
  }
  return textResult("Review plan approved — the reviewer is done, proceed.");
}
