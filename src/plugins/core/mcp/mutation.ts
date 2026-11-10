import { connect, type RequestBody } from "../bridgeClient.js";
import type { ReviewTarget, ToolResult } from "./reviewTool.js";
import { NO_WINDOW_MESSAGE, textResult } from "./reviewTool.js";

const CONNECT_TIMEOUT_MS = 3_000;

export const MUTATION_TIMEOUT_MS = 10_000;

export type MutationBody = Extract<
  RequestBody,
  { t: "feedback.reply.request" | "changes.describe.request" | "viz.show.request" }
>;

export async function runMutation(
  target: ReviewTarget | undefined,
  body: MutationBody,
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
    return textResult("The Paireto request did not complete.", true);
  }
  return textResult(response.message, !response.ok);
}
