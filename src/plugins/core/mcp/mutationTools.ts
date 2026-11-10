import { z } from "zod";

import type { Harness } from "../../../protocol/types.js";
import { VizArgs } from "../../../protocol/viz.js";
import { connect, type RequestBody } from "../bridgeClient.js";
import type { ReviewTarget, ToolResult } from "./reviewTool.js";
import { NO_WINDOW_MESSAGE, textResult } from "./reviewTool.js";

const CONNECT_TIMEOUT_MS = 3_000;

export const MUTATION_TIMEOUT_MS = 10_000;

export type MutationBody = Extract<
  RequestBody,
  { t: "feedback.reply.request" | "changes.describe.request" | "viz.show.request" }
>;

export interface MutationOrigin {
  readonly repoRoot: string;
  readonly cwd: string;
  readonly harness: Harness;
  readonly sessionId?: string;
}

export interface PiToolText {
  readonly label: string;
  readonly snippet: string;
  readonly guidelines: string[];
}

export interface MutationTool {
  readonly name: string;
  readonly description: string;
  readonly args: z.ZodObject | undefined;
  readonly pi: PiToolText;
  request(args: Record<string, unknown>, origin: MutationOrigin): MutationBody;
}

type ArgsOf<S extends z.ZodObject | undefined> = S extends z.ZodObject
  ? z.infer<S>
  : Record<string, unknown>;

interface MutationToolSpec<S extends z.ZodObject | undefined> {
  readonly name: string;
  readonly description: string;
  readonly args: S;
  readonly pi: PiToolText;
  request(args: ArgsOf<S>, origin: MutationOrigin): MutationBody;
}

function mutationTool<S extends z.ZodObject | undefined>(spec: MutationToolSpec<S>): MutationTool {
  return { ...spec, request: (args, origin) => spec.request(args as ArgsOf<S>, origin) };
}

export const FeedbackReplyArgs = z.object({
  feedbackId: z.string().trim().min(1).describe("The stable feedback ID."),
  message: z.string().trim().min(1).describe("The reply shown to the reviewer."),
});

export const FEEDBACK_REPLY_TOOL = mutationTool({
  name: "paireto_reply_to_feedback",
  description:
    "Answer one Paireto review question. Use the feedback ID returned by a review. Do not use this " +
    "for a comment: make the code changes the comment asks for and do not reply.",
  args: FeedbackReplyArgs,
  pi: {
    label: "Paireto Feedback Reply",
    snippet: "Answer one Paireto review question by its feedback ID",
    guidelines: [
      "Call paireto_reply_to_feedback to answer a reviewer question, using the feedback ID the review " +
        "returned. Do not change code for a question.",
      "Do not call paireto_reply_to_feedback for a reviewer comment. Make the code changes the comment " +
        "asks for instead.",
    ],
  },
  request: (args, origin) => ({
    t: "feedback.reply.request",
    repoRoot: origin.repoRoot,
    harness: origin.harness,
    sessionId: origin.sessionId,
    feedbackId: args.feedbackId,
    message: args.message,
  }),
});

export const GET_CHANGES_TOOL = mutationTool({
  name: "paireto_get_changes",
  description:
    "List what the connected VS Code window compares: its Compare To, each repo, the changed " +
    "files grouped by unit, and a level hint. Call this before paireto_show_viz.",
  args: undefined,
  pi: {
    label: "Paireto Changes",
    snippet: "List the connected VS Code window's Compare To, repos, changed files and units",
    guidelines: [
      "Call paireto_get_changes first when the user asks to visualize the changes, and read only " +
        "what its Compare To covers.",
    ],
  },
  request: (_args, origin) => ({
    t: "changes.describe.request",
    cwd: origin.cwd,
    repoRoot: origin.repoRoot,
    harness: origin.harness,
    sessionId: origin.sessionId,
  }),
});

export const SHOW_VIZ_TOOL = mutationTool({
  name: "paireto_show_viz",
  description:
    "Show how the changes fit together in the connected VS Code window: an overview graph, flows " +
    "as sequence diagrams, and a walkthrough. Returns at once: accepted with warnings, or every " +
    "error to fix before you call it again.",
  args: VizArgs,
  pi: {
    label: "Paireto Viz",
    snippet: "Show a diagram of how the changes fit together in the connected VS Code window",
    guidelines: [
      "Call paireto_show_viz after paireto_get_changes and after you read the diffs. On rejection, " +
        "fix every error and call it again. Never delete elements to pass.",
    ],
  },
  request: (args, origin) => ({
    t: "viz.show.request",
    cwd: origin.cwd,
    repoRoot: origin.repoRoot,
    harness: origin.harness,
    sessionId: origin.sessionId,
    viz: args,
  }),
});

export const MUTATION_TOOLS: readonly MutationTool[] = [
  FEEDBACK_REPLY_TOOL,
  GET_CHANGES_TOOL,
  SHOW_VIZ_TOOL,
];

export async function runMutationTool(
  tool: MutationTool,
  target: ReviewTarget | undefined,
  harness: Harness,
  args: Record<string, unknown>,
  noTargetMessage = NO_WINDOW_MESSAGE,
  timeoutMs = MUTATION_TIMEOUT_MS,
): Promise<ToolResult> {
  if (!target) {
    return textResult(noTargetMessage, true);
  }
  const body = tool.request(args, {
    repoRoot: target.target.repoRoot,
    cwd: target.cwd,
    harness,
    sessionId: target.sessionId,
  });
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
