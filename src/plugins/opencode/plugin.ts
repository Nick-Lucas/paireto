// Paireto OpenCode adapter. OpenCode autoloads global + project plugins LAZILY (on the first session
// op, not server boot), runs them in-process under Bun, and exposes an `event` hook, awaited
// `tool.execute.before/after` hooks, and custom `tool` registrations whose `execute()` can BLOCK the
// agent by returning a Promise<string>.
//
// This module bridges those onto the same per-repo Unix socket the Claude/Codex adapters use, via the
// shared client in src/plugins/core. Fail-open everywhere: no socket, connect failure or bad ack and
// the hook or tool silently degrades (events drop, gates return "proceed") rather than stalling or
// crashing the agent.

import { REVIEW_TOOL_DESCRIPTION, REVIEW_TOOL_NAME } from "../core/mcp/reviewTool.js";
import {
  agentModeFor,
  applyOpenCodeConfig,
  ensurePermission,
  getLastUserAgentFromMessages,
  isChildSession,
  isNewUserTurn,
  isPrimaryCapableAgent,
  isTitleGeneratorPrompt,
  normalizePrimaryTools,
  planToolArgs,
  resolveOpenCodeRoot,
  shouldInjectPlanningPrompt,
  stopGateInjectionReason,
} from "./automation.js";
import { createBridge } from "./bridge.js";
import { handleEvent, maybeRunStopGate, switchAgent } from "./dispatch.js";
import {
  PLAN_APPROVED,
  PLAN_CHANGES_REQUESTED,
  PLAN_EXIT_REDIRECT,
  PLAN_UNAVAILABLE,
  PLANNING_AGENTS,
  PLANNING_PROMPT,
  REVIEW_APPROVED,
  REVIEW_FAILED,
  REVIEW_UNAVAILABLE,
  SUBMIT_PLAN_DESCRIPTION,
  SUBMIT_PLAN_TOOL,
} from "./text.js";
import type {
  AgentInfo,
  OpenCodeConfig,
  OpenCodeEvent,
  PluginInput,
  ToolExecuteInput,
  ToolSchema,
} from "./types.js";

interface ToolContext {
  sessionID?: string;
}

export const PairetoOpenCode = async ({ worktree, client, directory }: PluginInput) => {
  const bridgeRoot = resolveOpenCodeRoot(worktree, directory);
  if (!bridgeRoot) {
    return {};
  }

  const bridge = createBridge(bridgeRoot);

  // OpenCode provides `@opencode-ai/plugin` in its own runtime (never bundled with us); its
  // `tool.schema` is the zod instance we need to declare the plan tool's arg. A DYNAMIC import, not a
  // top-level one, so this module's pure helpers stay importable in the unit tests (which don't have
  // the SDK installed and never invoke this factory). Fail-open: no SDK → the plan tool advertises no
  // args rather than crashing the session.
  let toolSchema: ToolSchema | null = null;
  try {
    const sdk = (await import("@opencode-ai/plugin")) as { tool?: { schema?: ToolSchema } };
    toolSchema = sdk?.tool?.schema ?? null;
  } catch {
    // Not running under OpenCode — leave the plan arg unschematized (never reached at runtime).
  }

  // The agents list is static per session; cache it so the system-prompt transform doesn't re-fetch
  // on every LLM call.
  let cachedAgents: AgentInfo[] | null = null;
  async function loadAgents(): Promise<AgentInfo[]> {
    if (cachedAgents) {
      return cachedAgents;
    }
    try {
      const response = await client.app.agents({ query: { directory } });
      cachedAgents = response?.data ?? [];
    } catch {
      cachedAgents = [];
    }
    return cachedAgents;
  }

  return {
    // The event bus. Never throws into OpenCode and returns immediately (telemetry forwarding is
    // fire-and-forget; the post-hoc stop gate is dispatched async and awaited only internally).
    event: async ({ event }: { event: OpenCodeEvent }) => {
      try {
        handleEvent(bridge, event);
        maybeRunStopGate(bridge, client, event);
      } catch {
        // fail open — telemetry must never break a turn
      }
    },

    // Scope the plan tool to planning agents. Runs before every session; idempotent. Fail-open — a
    // config error must not break the session.
    config: async (config: OpenCodeConfig) => {
      try {
        applyOpenCodeConfig(config, PLANNING_AGENTS);
      } catch {
        // fail open
      }
    },

    // Inject the lean planning instruction into a PLANNING session's system prompt so the agent
    // submits its plan via paireto_submit_plan instead of ending the turn.
    "experimental.chat.system.transform": async (
      input: { sessionID: string },
      output: { system: string[] },
    ) => {
      try {
        if (isTitleGeneratorPrompt(output.system.join("\n"))) {
          return;
        }
        const messages = await client.session.messages({ path: { id: input.sessionID } });
        const agentName = getLastUserAgentFromMessages(messages?.data);
        if (!agentName) {
          return;
        }
        const isSubagent = agentModeFor(agentName, await loadAgents()) === "subagent";
        if (
          shouldInjectPlanningPrompt({
            agentName,
            isSubagent,
            isTitleGenerator: false,
            planningAgents: PLANNING_AGENTS,
          })
        ) {
          output.system.push(PLANNING_PROMPT);
        }
      } catch {
        // fail open — never break a turn over prompt steering
      }
    },

    // Future-proofing: a newer or forked OpenCode may expose a `plan_exit` tool. If it shows up, point
    // the agent at paireto_submit_plan instead. No-op today.
    "tool.definition": async (input: { toolID?: string }, output: { description?: string }) => {
      try {
        if (input?.toolID === "plan_exit") {
          output.description = PLAN_EXIT_REDIRECT;
        }
      } catch {
        // fail open
      }
    },

    // Awaited tool hooks: re-emit as synthetic events and RETURN IMMEDIATELY. Blocking here would
    // stall every tool call; the plan gate rides the custom tool below, not here.
    "tool.execute.before": async (input: ToolExecuteInput) => {
      try {
        bridge.forwardTool("tool.execute.before", input);
      } catch {
        // fail open
      }
    },
    "tool.execute.after": async (input: ToolExecuteInput) => {
      try {
        bridge.forwardTool("tool.execute.after", input);
      } catch {
        // fail open
      }
    },

    // Custom tools whose execute() BLOCKS the agent until VS Code returns.
    tool: {
      [REVIEW_TOOL_NAME]: {
        description: REVIEW_TOOL_DESCRIPTION,
        args: {},
        execute: async (_args: unknown, ctx: ToolContext) => {
          const sessionID = typeof ctx?.sessionID === "string" ? ctx.sessionID : undefined;
          try {
            const response = await bridge.gate({
              t: "review.await.request",
              cwd: bridge.repoRoot,
              repoRoot: bridge.repoRoot,
              sessionId: sessionID,
            });
            if (!response) {
              return REVIEW_UNAVAILABLE;
            }
            return response.status === "submitted" && response.feedback
              ? response.feedback
              : REVIEW_APPROVED;
          } catch {
            return REVIEW_FAILED;
          }
        },
      },

      // Plan gate. The config hook and system-prompt transform steer planning agents onto this tool,
      // so it works with zero user setup. On APPROVE the extension may return a `nextMode` = the
      // TARGET AGENT to switch to, closing the "no mode switch" gap by prompting that agent to proceed.
      [SUBMIT_PLAN_TOOL]: {
        description: SUBMIT_PLAN_DESCRIPTION,
        args: planToolArgs(toolSchema),
        execute: async (args: { plan?: unknown }, ctx: ToolContext) => {
          const sessionID = typeof ctx?.sessionID === "string" ? ctx.sessionID : undefined;
          const plan = typeof args?.plan === "string" ? args.plan : "";
          try {
            const response = await bridge.gate({
              t: "plan.review.request",
              harness: "opencode",
              repoRoot: bridge.repoRoot,
              // Self-contained synthetic gate event per the seam invariant: the adapter injects the
              // plan markdown (OpenCode has no plan payload of its own).
              event: {
                type: "paireto.plan.submitted",
                properties: { sessionID },
                plan_markdown: plan,
              } as never,
            });
            if (!response) {
              return PLAN_UNAVAILABLE;
            }
            if (response.decision === "deny") {
              return response.reason || PLAN_CHANGES_REQUESTED;
            }
            // On approve with a target agent, switch BEFORE returning the go-ahead.
            const targetAgent =
              typeof response.nextMode === "string" ? response.nextMode : undefined;
            if (targetAgent && sessionID) {
              await switchAgent(client, sessionID, targetAgent);
            }
            return PLAN_APPROVED;
          } catch {
            return PLAN_UNAVAILABLE;
          }
        },
      },
    },
  };
};

// Test-only surface. OpenCode's plugin loader treats EVERY export as a plugin factory: a function
// export is invoked as `fn(pluginInput, options)` (a bare helper then crashes the boot — it reads
// its real parameters off the wrong objects), and a non-function export is a hard load error
// ("Plugin export is not a function"). So the helpers ride an INERT plugin: a callable that
// registers no hooks, with the helpers attached as properties for the unit tests to destructure.
export const _internals = Object.assign(async () => ({}), {
  normalizePrimaryTools,
  ensurePermission,
  isPrimaryCapableAgent,
  applyOpenCodeConfig,
  isNewUserTurn,
  isTitleGeneratorPrompt,
  getLastUserAgentFromMessages,
  agentModeFor,
  shouldInjectPlanningPrompt,
  isChildSession,
  stopGateInjectionReason,
  planToolArgs,
  resolveOpenCodeRoot,
});
