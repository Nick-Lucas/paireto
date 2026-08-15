import type { HarnessEventMeta } from "../protocol/types.js";
import type { Harness } from "../protocol/types.js";
import type { AppEvent, AppEventKind } from "./appEvent.js";
import type { AgentStrategy } from "./AgentStrategy.js";

export type KiroHookEventName =
  | "agentSpawn"
  | "userPromptSubmit"
  | "preToolUse"
  | "postToolUse"
  | "postFileCreate"
  | "postFileSave"
  | "postFileDelete"
  | "stop";

export interface KiroHookEvent {
  hook_event_name: KiroHookEventName;
  session_id: string;
  cwd: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  file_path?: string;
  assistant_response?: string;
}

const EDIT_TOOLS: ReadonlySet<string> = new Set(["write", "fs_write", "fsWrite"]);

const KIRO_KIND: Partial<Record<KiroHookEventName, AppEventKind>> = {
  agentSpawn: "sessionStart",
  userPromptSubmit: "userPromptSubmit",
  preToolUse: "preToolUse",
  postToolUse: "postToolUse",
  postFileCreate: "fileChanged",
  postFileSave: "fileChanged",
  postFileDelete: "fileChanged",
  stop: "stop",
};

function toolPlan(event: KiroHookEvent): string | undefined {
  if (
    event.hook_event_name !== "preToolUse" ||
    event.tool_name !== "switch_to_execution" ||
    !event.tool_input ||
    typeof event.tool_input !== "object"
  ) {
    return undefined;
  }
  const plan = (event.tool_input as { plan?: unknown }).plan;
  return typeof plan === "string" && plan.length > 0 ? plan : undefined;
}

export class KiroStrategy implements AgentStrategy {
  readonly harness: Harness = "kiro";
  readonly displayName = "Kiro";
  readonly planToolName = "switch_to_execution";
  readonly defaultPlanApproveMode: string | undefined = undefined;
  readonly supportsLiveness = false;

  toAppEvent(event: KiroHookEvent, meta?: HarnessEventMeta): AppEvent | undefined {
    const nativePlan = toolPlan(event);
    const fallbackPlan = event.hook_event_name === "stop" ? meta?.planMarkdown : undefined;
    const kind =
      nativePlan !== undefined || fallbackPlan !== undefined
        ? "planProposal"
        : KIRO_KIND[event.hook_event_name];
    if (!kind) {
      return undefined;
    }
    return {
      kind,
      harness: this.harness,
      sessionId: event.session_id,
      toolName: event.tool_name,
      isEditTool: EDIT_TOOLS.has(event.tool_name ?? ""),
      planText: nativePlan ?? fallbackPlan,
      backgroundTaskCount: 0,
      sessionCronCount: 0,
    };
  }

  describeEvent(event: KiroHookEvent): string {
    const agent = event.session_id ? ` agent=${event.session_id.slice(0, 8)}` : "";
    const tool = event.tool_name ? ` tool=${event.tool_name}` : "";
    return `${event.hook_event_name}${agent}${tool}`;
  }
}
