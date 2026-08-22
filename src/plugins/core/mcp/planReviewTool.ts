// The `paireto_plan_review` tool: one definition, shared by every harness's MCP server.
//
// A harness whose turn-end hooks cannot raise a second plan gate has no way to put a REVISED plan
// back in front of the reviewer — the first proposal arrives by hook, and after that the loop is
// closed. This tool is that way back: the agent hands over the plan it has just revised and blocks
// on the same gate the hook path uses.
//
// The name and description are part of the agent-facing contract — the model decides whether to call
// this from the description alone, and the e2e replay fixtures match on it — so treat both as fixed
// text rather than something to reword freely.

import { z } from "zod";

import type { Harness } from "../../../protocol/types.js";
import { connect } from "../bridgeClient.js";
import { NO_WINDOW_MESSAGE, textResult, type ReviewTarget, type ToolResult } from "./reviewTool.js";

export const PLAN_REVIEW_TOOL_NAME = "paireto_plan_review";

export const PLAN_REVIEW_TOOL_DESCRIPTION =
  "Submit a plan to the human reviewer in the connected VS Code window and wait for their answer. " +
  "Blocks until the reviewer approves the plan or sends feedback on it, then returns their " +
  "decision. Call this after revising a plan in response to plan review feedback.";

export const PLAN_APPROVED = "Plan approved — proceed with the work.";

export const PlanReviewArgs = z.object({
  plan: z.string().describe("The full plan markdown to put in front of the reviewer."),
});

const CONNECT_TIMEOUT_MS = 3000;

/** Run one blocking plan-review round-trip. Resolves only once the reviewer decides, the window goes
 *  away, or the connection drops — the MCP client's own tool timeout is the outer bound. */
export async function runPlanReview(
  reviewTarget: ReviewTarget | undefined,
  harness: Harness,
  plan: string,
  noTargetMessage: string = NO_WINDOW_MESSAGE,
): Promise<ToolResult> {
  if (!reviewTarget) {
    return textResult(noTargetMessage, true);
  }
  if (!plan.trim()) {
    return textResult("Call paireto_plan_review with the plan to review.", true);
  }

  const result = await connect(reviewTarget.target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    return result.reason === "no-socket"
      ? textResult(NO_WINDOW_MESSAGE, true)
      : textResult(`Could not connect to the VS Code Paireto bridge (${result.reason}).`, true);
  }

  const response = await result.connection.request({
    t: "plan.review.tool.request",
    cwd: reviewTarget.cwd,
    repoRoot: reviewTarget.target.repoRoot,
    sessionId: reviewTarget.sessionId,
    harness,
    plan,
  });
  result.connection.close();

  if (!response) {
    return textResult("Plan review session closed.");
  }
  // `deny` is the reviewer asking for changes, so its reason is the feedback to act on. An `allow`
  // carries a reason too when the harness has rules for what to do once the approved work is
  // finished — dropping it here would strand a harness that has no turn-end hook left to hear them.
  if (response.decision === "deny" && response.reason) {
    return textResult(response.reason);
  }
  return textResult(response.reason ? `${PLAN_APPROVED}\n\n${response.reason}` : PLAN_APPROVED);
}
