import { GuidedReviewArgs } from "../../protocol/guidedReview.js";
import {
  FEEDBACK_REPLY_TOOL_DESCRIPTION,
  FEEDBACK_REPLY_TOOL_NAME,
  FeedbackReplyArgs,
} from "../core/mcp/feedbackTools.js";
import {
  GUIDED_REVIEW_TOOL_DESCRIPTION,
  GUIDED_REVIEW_TOOL_NAME,
} from "../core/mcp/guidedReviewTool.js";
import { REVIEW_TOOL_DESCRIPTION, REVIEW_TOOL_NAME } from "../core/mcp/reviewTool.js";
import { gitToplevel } from "../core/target.js";
import {
  blocksInPlanMode,
  mutatedPath,
  resolvePiRoot,
  stopGateInjectionReason,
  SubmitPlanArgs,
  toolSchema,
  truncateToolText,
} from "./automation.js";
import type { PiBridge } from "./bridge.js";
import { createBridge } from "./bridge.js";
import {
  FEEDBACK_REPLY_GUIDELINES,
  FEEDBACK_REPLY_SNIPPET,
  GUIDED_REVIEW_APPROVED,
  GUIDED_REVIEW_GUIDELINES,
  GUIDED_REVIEW_SNIPPET,
  PLAN_APPROVED,
  PLAN_CHANGES_REQUESTED,
  PLAN_COMMAND,
  PLAN_COMMAND_DESCRIPTION,
  PLAN_MODE_ARMED,
  PLAN_MODE_BLOCKED_TOOL,
  PLAN_UNAVAILABLE,
  PLANNING_PROMPT,
  REVIEW_APPROVED,
  REVIEW_CANCELLED,
  REVIEW_FAILED,
  REVIEW_GUIDELINES,
  REVIEW_SNIPPET,
  REVIEW_UNAVAILABLE,
  SUBMIT_PLAN_DESCRIPTION,
  SUBMIT_PLAN_GUIDELINES,
  SUBMIT_PLAN_SNIPPET,
  SUBMIT_PLAN_TOOL,
} from "./text.js";
import type { PiExtensionAPI, PiExtensionContext, PiToolResult } from "./types.js";

const PLAN_SCHEMA = toolSchema(SubmitPlanArgs);
const GUIDED_SCHEMA = toolSchema(GuidedReviewArgs);
const FEEDBACK_SCHEMA = toolSchema(FeedbackReplyArgs);

function text(value: string): PiToolResult {
  return { content: [{ type: "text", text: truncateToolText(value) }], details: {} };
}

export default function paireto(pi: PiExtensionAPI): void {
  let bridge: PiBridge | undefined;
  let planMode = false;
  const mutatedPaths = new Map<string, string>();

  function bridgeFor(ctx: PiExtensionContext): PiBridge | undefined {
    if (bridge) {
      return bridge;
    }
    const cwd = ctx.cwd || ctx.sessionManager.getCwd();
    const repoRoot = resolvePiRoot(cwd, gitToplevel(cwd));
    if (!repoRoot) {
      return undefined;
    }
    bridge = createBridge(repoRoot);
    return bridge;
  }

  function sessionId(ctx: PiExtensionContext): string | undefined {
    try {
      const id = ctx.sessionManager.getSessionId();
      return typeof id === "string" && id !== "" ? id : undefined;
    } catch {
      return undefined;
    }
  }

  function forward(
    ctx: PiExtensionContext,
    type: Parameters<PiBridge["forward"]>[0],
    extra: { tool?: string; toolCallId?: string; file?: string } = {},
  ): void {
    try {
      const id = sessionId(ctx);
      const connected = bridgeFor(ctx);
      if (!id || !connected) {
        return;
      }
      connected.forward(type, { sessionId: id, ...extra });
    } catch {
      // fail open — telemetry must never break a turn
    }
  }

  pi.on("session_start", (_event, ctx) => {
    planMode = false;
    mutatedPaths.clear();
    try {
      const id = sessionId(ctx);
      const connected = bridgeFor(ctx);
      if (id && connected) {
        connected.attachLiveness(id);
      }
    } catch {
      // fail open
    }
    forward(ctx, "session_start");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    forward(ctx, "session_shutdown");
    mutatedPaths.clear();
    try {
      await bridge?.closeAll();
    } catch {
      // fail open
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    forward(ctx, "before_agent_start");
    if (!planMode) {
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${PLANNING_PROMPT}` };
  });

  pi.on("tool_call", (event) => {
    if (blocksInPlanMode(planMode, event.toolName)) {
      return { block: true, reason: PLAN_MODE_BLOCKED_TOOL };
    }
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const file = mutatedPath(event.toolName, event.args);
    if (file) {
      mutatedPaths.set(event.toolCallId, file);
    }
    forward(ctx, "tool_execution_start", {
      tool: event.toolName,
      toolCallId: event.toolCallId,
    });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const file = mutatedPaths.get(event.toolCallId);
    mutatedPaths.delete(event.toolCallId);
    forward(ctx, "tool_execution_end", {
      tool: event.toolName,
      toolCallId: event.toolCallId,
    });
    if (file && !event.isError) {
      forward(ctx, "file_changed", { tool: event.toolName, file });
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    forward(ctx, "agent_settled");
    const id = sessionId(ctx);
    const connected = bridgeFor(ctx);
    if (!id || !connected) {
      return;
    }
    void connected
      .gate({
        t: "stop.gate.request",
        harness: "pi",
        repoRoot: connected.repoRoot,
        event: { type: "agent_settled", properties: { sessionId: id } } as never,
      })
      .then((response) => {
        const reason = stopGateInjectionReason(response);
        if (reason) {
          pi.sendUserMessage(reason);
        }
      })
      .catch(() => {});
  });

  pi.registerCommand(PLAN_COMMAND, {
    description: PLAN_COMMAND_DESCRIPTION,
    handler: (args, ctx) => {
      planMode = true;
      const prompt = args.trim();
      if (prompt) {
        pi.sendUserMessage(prompt);
      } else if (ctx.hasUI) {
        ctx.ui.notify(PLAN_MODE_ARMED, "info");
      }
      return Promise.resolve();
    },
  });

  pi.registerTool<SubmitPlanArgs>({
    name: SUBMIT_PLAN_TOOL,
    label: "Paireto Plan Review",
    description: SUBMIT_PLAN_DESCRIPTION,
    promptSnippet: SUBMIT_PLAN_SNIPPET,
    promptGuidelines: SUBMIT_PLAN_GUIDELINES,
    parameters: PLAN_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const connected = bridgeFor(ctx);
      if (!connected) {
        return text(PLAN_UNAVAILABLE);
      }
      try {
        const response = await connected.gate(
          {
            t: "plan.review.hook.request",
            harness: "pi",
            repoRoot: connected.repoRoot,
            event: {
              type: "paireto.plan.submitted",
              properties: { sessionId: sessionId(ctx) ?? "" },
              plan_markdown: params?.plan ?? "",
            } as never,
          },
          signal,
        );
        if (!response) {
          return text(signal?.aborted ? REVIEW_CANCELLED : PLAN_UNAVAILABLE);
        }
        if (response.decision === "deny") {
          return text(response.reason || PLAN_CHANGES_REQUESTED);
        }
        planMode = false;
        return text(PLAN_APPROVED);
      } catch {
        return text(PLAN_UNAVAILABLE);
      }
    },
  });

  pi.registerTool<Record<string, never>>({
    name: REVIEW_TOOL_NAME,
    label: "Paireto Review",
    description: REVIEW_TOOL_DESCRIPTION,
    promptSnippet: REVIEW_SNIPPET,
    promptGuidelines: REVIEW_GUIDELINES,
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
      const connected = bridgeFor(ctx);
      if (!connected) {
        return text(REVIEW_UNAVAILABLE);
      }
      try {
        const response = await connected.gate(
          {
            t: "review.await.request",
            cwd: connected.repoRoot,
            repoRoot: connected.repoRoot,
            sessionId: sessionId(ctx),
            harness: "pi",
          },
          signal,
        );
        if (!response) {
          return text(signal?.aborted ? REVIEW_CANCELLED : REVIEW_UNAVAILABLE);
        }
        return text(
          response.status === "submitted" && response.feedback
            ? response.feedback
            : REVIEW_APPROVED,
        );
      } catch {
        return text(REVIEW_FAILED);
      }
    },
  });

  pi.registerTool<GuidedReviewArgs>({
    name: GUIDED_REVIEW_TOOL_NAME,
    label: "Paireto Guided Review",
    description: GUIDED_REVIEW_TOOL_DESCRIPTION,
    promptSnippet: GUIDED_REVIEW_SNIPPET,
    promptGuidelines: GUIDED_REVIEW_GUIDELINES,
    parameters: GUIDED_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const connected = bridgeFor(ctx);
      if (!connected) {
        return text(REVIEW_UNAVAILABLE);
      }
      try {
        const response = await connected.gate(
          {
            t: "guided.review.await.request",
            cwd: connected.repoRoot,
            repoRoot: connected.repoRoot,
            harness: "pi",
            sessionId: sessionId(ctx),
            summary: params?.summary,
            compareTo: params?.compareTo,
            changesets: params?.changesets ?? [],
          },
          signal,
        );
        if (!response) {
          return text(signal?.aborted ? REVIEW_CANCELLED : REVIEW_UNAVAILABLE);
        }
        return text(
          response.status === "submitted" && response.feedback
            ? response.feedback
            : GUIDED_REVIEW_APPROVED,
        );
      } catch {
        return text(REVIEW_FAILED);
      }
    },
  });

  pi.registerTool<FeedbackReplyArgs>({
    name: FEEDBACK_REPLY_TOOL_NAME,
    label: "Paireto Feedback Reply",
    description: FEEDBACK_REPLY_TOOL_DESCRIPTION,
    promptSnippet: FEEDBACK_REPLY_SNIPPET,
    promptGuidelines: FEEDBACK_REPLY_GUIDELINES,
    parameters: FEEDBACK_SCHEMA,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const connected = bridgeFor(ctx);
      if (!connected) {
        throw new Error(REVIEW_UNAVAILABLE);
      }
      const response = await connected.gate(
        {
          t: "feedback.reply.request",
          repoRoot: connected.repoRoot,
          harness: "pi",
          sessionId: sessionId(ctx),
          feedbackId: params.feedbackId,
          message: params.message,
        },
        signal,
      );
      if (!response) {
        throw new Error(REVIEW_UNAVAILABLE);
      }
      if (!response.ok) {
        throw new Error(response.message);
      }
      return text(response.message);
    },
  });
}
