import type { HarnessEventMeta } from "../protocol/types.js";
import type { Harness } from "../protocol/types.js";
import type { AppEvent, AppEventKind } from "./appEvent.js";
import type { AgentStrategy } from "./AgentStrategy.js";
import type { HarnessInstruction } from "./instructions.js";

/** The canonical trigger names Kiro puts in a hook's `hook_event_name`. Kiro accepts several
 *  spellings in a hook FILE and normalizes them to these before it runs the command, so the payload
 *  a hook reads is always PascalCase. */
export type KiroHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostFileCreate"
  | "PostFileSave"
  | "PostFileDelete"
  | "Stop";

export interface KiroHookEvent {
  hook_event_name: KiroHookEventName;
  session_id: string;
  cwd: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  file_path?: string;
}

/** The tools Kiro itself classifies as `fs_write`. A turn only earns a review when it changed
 *  files, so a name missing here means the turn-end review never opens. */
const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "fs_write",
  "fs_append",
  "str_replace",
  "delete_file",
  "edit_code",
  "semantic_rename",
  "smart_relocate",
]);

const KIRO_KIND: Partial<Record<KiroHookEventName, AppEventKind>> = {
  SessionStart: "sessionStart",
  UserPromptSubmit: "userPromptSubmit",
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  PostFileCreate: "fileChanged",
  PostFileSave: "fileChanged",
  PostFileDelete: "fileChanged",
  Stop: "stop",
};

function toolPlan(event: KiroHookEvent): string | undefined {
  if (
    event.hook_event_name !== "PreToolUse" ||
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
  /** Kiro only runs Stop hooks once per turn
   * So the agent has to reopen the review itself for further feedback
   */
  readonly extraPlanReviewResponseInstructions: HarnessInstruction[] = [
    {
      when: "rejected",
      instruction:
        "Do not ask the user whether the revised plan is good — call switch_to_execution with it.",
    },
    {
      when: "approved",
      instruction:
        "When you have finished implementing this plan, call the paireto_review tool to open the " +
        "code review. Do not stop before calling it.",
    },
  ];
  /** Kiro's agent server runs Stop hooks once per graph run (`onAgentStopHooksExecuted`), and
   *  delivering this feedback already spent that one pass — no further turn-end hook will fire, so
   *  the agent has to reopen the review itself or the loop ends here. */
  readonly extraReviewResponseInstructions: HarnessInstruction[] = [
    {
      when: "rejected",
      instruction:
        "When you have finished addressing this feedback, call the paireto_review tool the reviewer can check your changes.",
    },
  ];
  readonly defaultPlanApproveMode: string | undefined = undefined;
  readonly supportsLiveness = false;

  toAppEvent(event: KiroHookEvent, meta?: HarnessEventMeta): AppEvent | undefined {
    const nativePlan = toolPlan(event);
    const fallbackPlan = event.hook_event_name === "Stop" ? meta?.planMarkdown : undefined;
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
