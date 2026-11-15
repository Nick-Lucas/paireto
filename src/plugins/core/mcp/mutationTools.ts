import { z } from "zod";

import type { Harness } from "../../../protocol/types.js";
import { VizGenerateArgs, VizPresentArgs } from "../../../protocol/viz.js";
import { connect, type RequestBody } from "../bridgeClient.js";
import type { ReviewTarget, ToolResult } from "./reviewTool.js";
import { NO_WINDOW_MESSAGE, textResult } from "./reviewTool.js";

const CONNECT_TIMEOUT_MS = 3_000;

export const MUTATION_TIMEOUT_MS = 10_000;

export type MutationBody = Extract<
  RequestBody,
  { t: "feedback.reply.request" | "viz.generate.request" | "viz.present.request" }
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

export const VIZ_GENERATE_TOOL = mutationTool({
  name: "paireto_viz_generate",
  description:
    "Write the viz file .paireto/viz/<name>.viz.json in the repo and return its path and a summary " +
    "of what the connected VS Code window compares. base changes: Paireto builds class nodes from " +
    "the Compare To diff. base none: an empty skeleton you fill. Then edit the file and call " +
    "paireto_viz_present.",
  args: VizGenerateArgs,
  pi: {
    label: "Paireto Viz Generate",
    snippet: "Write a Paireto viz file for the changes and return its path and the change summary",
    guidelines: [
      "Call paireto_viz_generate first when the user asks to visualize the changes. Choose base " +
        "changes for code structure and none for concepts the code does not name.",
      "After paireto_viz_generate, read the diffs it lists, edit the viz file it wrote, then call " +
        "paireto_viz_present.",
    ],
  },
  request: (args, origin) => ({
    t: "viz.generate.request",
    cwd: origin.cwd,
    repoRoot: origin.repoRoot,
    harness: origin.harness,
    sessionId: origin.sessionId,
    args,
  }),
});

export const VIZ_PRESENT_TOOL = mutationTool({
  name: "paireto_viz_present",
  description:
    "Check the viz file .paireto/viz/<name>.viz.json and open it in the connected VS Code window. " +
    "Returns at once: a summary with warnings, or every error with its JSON path to fix in the " +
    "file before you call it again.",
  args: VizPresentArgs,
  pi: {
    label: "Paireto Viz Present",
    snippet: "Check a Paireto viz file and open it in the connected VS Code window",
    guidelines: [
      "Call paireto_viz_present after you edit the viz file. On errors, fix every one in the file " +
        "and call it again. Never delete elements to pass.",
    ],
  },
  request: (args, origin) => ({
    t: "viz.present.request",
    cwd: origin.cwd,
    repoRoot: origin.repoRoot,
    harness: origin.harness,
    sessionId: origin.sessionId,
    args,
  }),
});

export const MUTATION_TOOLS: readonly MutationTool[] = [
  FEEDBACK_REPLY_TOOL,
  VIZ_GENERATE_TOOL,
  VIZ_PRESENT_TOOL,
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
