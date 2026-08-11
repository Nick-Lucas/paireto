// The `paireto_review` tool: one definition, shared by every harness's MCP server.
//
// The name and description are part of the agent-facing contract — the model decides whether to
// call this from the description alone, and the e2e replay fixtures match on it — so treat both as
// fixed text rather than something to reword freely.

import { connect } from "../bridgeClient.js";
import type { BridgeTarget } from "../target.js";

export const REVIEW_TOOL_NAME = "paireto_review";

export const REVIEW_TOOL_DESCRIPTION =
  "Open an interactive code review in the connected VS Code window and wait for the user to " +
  "submit feedback. Blocks until the user clicks Send Feedback or Cancel, then returns the " +
  "review comments (file:line, kind, note) to act on. Call this when the user asks for a review.";

/** No arguments. An empty shape advertises an object schema with no properties. */
export const REVIEW_TOOL_INPUT_SCHEMA = {} as const;

const CONNECT_TIMEOUT_MS = 3000;

/** Where a review round-trip goes. Resolved per call, because Codex only learns it after the first
 *  prompt has written its handoff file. */
export interface ReviewTarget {
  readonly target: BridgeTarget;
  readonly cwd: string;
  readonly sessionId?: string;
}

export interface ToolResult {
  /** The SDK's result type carries arbitrary extra fields; this keeps ours assignable to it. */
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export const NO_WINDOW_MESSAGE =
  "No VS Code Paireto is listening for this repository. Open the project in VS Code " +
  "(with the Paireto extension active) and try again.";

/**
 * Run one blocking review round-trip. Resolves only once the user submits or cancels, the window
 * goes away, or the connection drops — the MCP client's own tool timeout is the outer bound.
 *
 * `noTargetMessage` lets a harness explain WHY it has no target: Codex cannot identify its session
 * until a prompt has written the handoff, which is a different problem to a closed VS Code window.
 */
export async function runReview(
  reviewTarget: ReviewTarget | undefined,
  noTargetMessage: string = NO_WINDOW_MESSAGE,
): Promise<ToolResult> {
  if (!reviewTarget) {
    return textResult(noTargetMessage, true);
  }

  const result = await connect(reviewTarget.target, { timeoutMs: CONNECT_TIMEOUT_MS });
  if (!result.ok) {
    // A socket that is not there at all means no window; anything else is a live socket we failed
    // to talk to, which is worth reporting differently.
    return result.reason === "no-socket"
      ? textResult(NO_WINDOW_MESSAGE, true)
      : textResult(`Could not connect to the VS Code Paireto bridge (${result.reason}).`, true);
  }

  const response = await result.connection.request({
    t: "review.await.request",
    cwd: reviewTarget.cwd,
    repoRoot: reviewTarget.target.repoRoot,
    sessionId: reviewTarget.sessionId,
  });
  result.connection.close();

  if (!response) {
    return textResult("Review session closed.");
  }
  if (response.status === "submitted" && response.feedback) {
    return textResult(response.feedback);
  }
  return textResult("Review approved — proceeding with no changes.");
}
