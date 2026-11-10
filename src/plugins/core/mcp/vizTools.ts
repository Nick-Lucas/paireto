import type { Harness } from "../../../protocol/types.js";
import { MUTATION_TIMEOUT_MS, runMutation } from "./mutation.js";
import type { ReviewTarget, ToolResult } from "./reviewTool.js";
import { NO_WINDOW_MESSAGE } from "./reviewTool.js";

export const GET_CHANGES_TOOL_NAME = "paireto_get_changes";

export const GET_CHANGES_TOOL_DESCRIPTION =
  "List what the connected VS Code window compares: its Compare To, each repo, the changed " +
  "files grouped by unit, and a level hint. Call this before paireto_show_viz.";

export const SHOW_VIZ_TOOL_NAME = "paireto_show_viz";

export const SHOW_VIZ_TOOL_DESCRIPTION =
  "Show how the changes fit together in the connected VS Code window: an overview graph, flows " +
  "as sequence diagrams, and a walkthrough. Returns at once: accepted with warnings, or every " +
  "error to fix before you call it again.";

export function runGetChanges(
  target: ReviewTarget | undefined,
  harness: Harness,
  noTargetMessage = NO_WINDOW_MESSAGE,
  timeoutMs = MUTATION_TIMEOUT_MS,
): Promise<ToolResult> {
  return runMutation(
    target,
    {
      t: "changes.describe.request",
      cwd: target?.cwd ?? "",
      repoRoot: target?.target.repoRoot ?? "",
      harness,
      sessionId: target?.sessionId,
    },
    noTargetMessage,
    timeoutMs,
  );
}

export function runShowViz(
  target: ReviewTarget | undefined,
  harness: Harness,
  viz: unknown,
  noTargetMessage = NO_WINDOW_MESSAGE,
  timeoutMs = MUTATION_TIMEOUT_MS,
): Promise<ToolResult> {
  return runMutation(
    target,
    {
      t: "viz.show.request",
      cwd: target?.cwd ?? "",
      repoRoot: target?.target.repoRoot ?? "",
      harness,
      sessionId: target?.sessionId,
      viz,
    },
    noTargetMessage,
    timeoutMs,
  );
}
