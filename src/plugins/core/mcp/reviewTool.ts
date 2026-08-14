// The `paireto_review` tool: one definition, shared by every harness's MCP server.
//
// The name and description are part of the agent-facing contract — the model decides whether to
// call this from the description alone, and the e2e replay fixtures match on it — so treat both as
// fixed text rather than something to reword freely.

import type { Harness } from "../../../protocol/types.js";
import type { ConnectFailure } from "../bridgeClient.js";
import { connect } from "../bridgeClient.js";
import { refusedMessage } from "../ndjson.js";
import type { BridgeTarget } from "../target.js";

export const REVIEW_TOOL_NAME = "paireto_review";

export const REVIEW_TOOL_DESCRIPTION =
  "Open an interactive code review in the connected VS Code window and wait for the user to " +
  "submit feedback. Blocks until the user clicks Send Feedback or Approve, then returns " +
  "review comments with stable feedback IDs. Call this when the user asks for a review.";

export const REVIEW_APPROVED = "Review approved — proceeding with no changes.";

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
 * Turn a failed connect into something the reader can act on.
 *
 * A refusal is the one failure that is not about the socket at all: the window is right there and
 * answering, it just speaks a different wire version to this bundle. Reporting that as a connection
 * failure sends the reader looking at sockets instead of at the plugin they need to reload.
 */
export function connectFailureMessage(reason: ConnectFailure, extVersion?: string): string {
  if (reason === "no-socket") {
    return NO_WINDOW_MESSAGE;
  }
  if (reason === "handshake-rejected") {
    return refusedMessage(extVersion);
  }
  return `Could not connect to the VS Code Paireto bridge (${reason}).`;
}

/**
 * Run one blocking review round-trip. Resolves only once the user submits or cancels, the window
 * goes away, or the connection drops — the MCP client's own tool timeout is the outer bound.
 *
 * `noTargetMessage` lets a harness explain WHY it has no target: Codex cannot identify its session
 * until a prompt has written the handoff, which is a different problem to a closed VS Code window.
 */
export async function runReview(
  reviewTarget: ReviewTarget | undefined,
  harness: Harness,
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
    t: "review.await.request",
    cwd: reviewTarget.cwd,
    repoRoot: reviewTarget.target.repoRoot,
    sessionId: reviewTarget.sessionId,
    harness,
  });
  result.connection.close();

  if (!response) {
    return textResult("Review session closed.");
  }
  if (response.status === "submitted" && response.feedback) {
    return textResult(response.feedback);
  }
  return textResult(REVIEW_APPROVED);
}
