// The `paireto_start_guided_review` tool: one definition, shared by every harness's MCP server.
//
// Like `paireto_review`, the name and description are part of the agent-facing contract — the model
// decides whether to call this from the description alone, and the e2e replay fixtures match on the
// whole tool inventory — so treat the text and the schema as fixed rather than reworded freely.

import { z } from "zod";

import { connect } from "../bridgeClient.js";
import type { ReviewTarget, ToolResult } from "./reviewTool.js";
import { NO_WINDOW_MESSAGE, textResult } from "./reviewTool.js";

export const GUIDED_REVIEW_TOOL_NAME = "paireto_start_guided_review";

export const GUIDED_REVIEW_TOOL_DESCRIPTION =
  "Hand a review plan to the human reviewer and wait for their verdict. Blocks until they " +
  "approve or send feedback, then returns the feedback to act on.";

/** The tool's arguments, as the shape the MCP SDK turns into the advertised JSON schema. */
export const GUIDED_REVIEW_TOOL_INPUT_SCHEMA = {
  summary: z.string().optional().describe("One paragraph on the branch."),
  compareTo: z
    .object({
      kind: z
        .enum(["head", "mergeBase", "default", "ref"])
        .describe(
          "head = uncommitted work; mergeBase = this branch since it forked; default = the " +
            "default branch tip; ref = the named ref.",
        ),
      ref: z.string().optional().describe("For kind 'ref'."),
    })
    .optional()
    .describe("What you diffed against. Must match what you reviewed."),
  changesets: z
    .array(
      z.object({
        title: z.string().describe("Names this group of changes."),
        description: z.string().describe("What it does and why."),
        files: z
          .array(
            z.object({
              path: z.string().describe("Repository-relative."),
              note: z.string().optional().describe("Why this file matters here."),
            }),
          )
          .describe("In reading order."),
      }),
    )
    .describe("Changed files grouped by intent."),
} as const;

export type GuidedReviewArgs = {
  [K in keyof typeof GUIDED_REVIEW_TOOL_INPUT_SCHEMA]: z.infer<
    (typeof GUIDED_REVIEW_TOOL_INPUT_SCHEMA)[K]
  >;
};

const CONNECT_TIMEOUT_MS = 3000;

/**
 * Hand the plan over and block until the reviewer resolves it. Same lifetime and failure modes as
 * {@link runReview} — the reviewer works through the plan for as long as they like, and the MCP
 * client's own tool timeout is the outer bound.
 */
export async function runGuidedReview(
  reviewTarget: ReviewTarget | undefined,
  args: GuidedReviewArgs,
  noTargetMessage: string = NO_WINDOW_MESSAGE,
): Promise<ToolResult> {
  if (!reviewTarget) {
    return textResult(noTargetMessage, true);
  }

  const result = await connect(reviewTarget.target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    return result.reason === "no-socket"
      ? textResult(NO_WINDOW_MESSAGE, true)
      : textResult(`Could not connect to the VS Code Paireto bridge (${result.reason}).`, true);
  }

  const response = await result.connection.request({
    t: "guided.review.await.request",
    cwd: reviewTarget.cwd,
    repoRoot: reviewTarget.target.repoRoot,
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
