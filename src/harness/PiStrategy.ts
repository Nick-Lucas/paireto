import type { HarnessEventMeta } from "../protocol/types.js";
import type { Harness } from "../protocol/types.js";
import type { AppEvent, AppEventKind } from "./appEvent.js";
import type { AgentStrategy } from "./AgentStrategy.js";

export type PiEventType =
  | "session_start"
  | "session_shutdown"
  | "before_agent_start"
  | "tool_execution_start"
  | "tool_execution_end"
  | "file_changed"
  | "agent_settled"
  | "paireto.plan.submitted";

export interface PiEventProperties {
  sessionId: string;
  tool?: string;
  toolCallId?: string;
  file?: string;
}

export interface PiForwardedEvent {
  type: PiEventType;
  properties: PiEventProperties;
  plan_markdown?: string;
}

const PLAN_TOOL = "paireto_submit_plan";

const PI_KIND: Record<PiEventType, AppEventKind> = {
  session_start: "sessionStart",
  session_shutdown: "sessionEnd",
  before_agent_start: "userPromptSubmit",
  tool_execution_start: "preToolUse",
  tool_execution_end: "postToolUse",
  file_changed: "fileChanged",
  agent_settled: "stop",
  "paireto.plan.submitted": "planProposal",
};

export class PiStrategy implements AgentStrategy {
  readonly harness: Harness = "pi";
  readonly displayName = "Pi";
  readonly planToolName = PLAN_TOOL;
  readonly supportsTurnEndReview = true;
  readonly defaultPlanApproveMode: string | undefined = undefined;
  readonly supportsLiveness = true;

  toAppEvent(event: PiForwardedEvent, _meta?: HarnessEventMeta): AppEvent | undefined {
    const props = event.properties;
    if (!props?.sessionId) {
      return undefined;
    }
    const kind =
      event.type === "tool_execution_start" && props.tool === PLAN_TOOL
        ? "planProposal"
        : PI_KIND[event.type];
    if (!kind) {
      return undefined;
    }
    return {
      kind,
      harness: this.harness,
      sessionId: props.sessionId,
      toolName: props.tool,
      planText: event.plan_markdown,
      backgroundTaskCount: 0,
      sessionCronCount: 0,
    };
  }

  describeEvent(event: PiForwardedEvent): string {
    const session = event.properties?.sessionId;
    const agent = session ? ` agent=${session.slice(0, 8)}` : "";
    const tool = event.properties?.tool ? ` tool=${event.properties.tool}` : "";
    return `${event.type}${agent}${tool}`;
  }
}
