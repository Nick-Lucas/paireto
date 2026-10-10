import { PiStrategy } from "../harness/PiStrategy.js";
import type { PiForwardedEvent } from "../harness/PiStrategy.js";
import { runMapperFixtures } from "./harnessFixtures.js";

const SESSION = "01a09691-0000-7000-8000-000000000000";

function ev(
  type: PiForwardedEvent["type"],
  properties: Partial<PiForwardedEvent["properties"]> = {},
  extra: Partial<PiForwardedEvent> = {},
): PiForwardedEvent {
  return { type, properties: { sessionId: SESSION, ...properties }, ...extra };
}

suite("PiStrategy mapper fixtures", () => {
  const pi = new PiStrategy();

  runMapperFixtures(pi, [
    {
      name: "session_start → sessionStart",
      raw: ev("session_start"),
      expect: { kind: "sessionStart", harness: "pi", sessionId: SESSION, agentId: undefined },
    },
    {
      name: "session_shutdown → sessionEnd",
      raw: ev("session_shutdown"),
      expect: { kind: "sessionEnd", sessionId: SESSION },
    },
    {
      name: "before_agent_start → userPromptSubmit",
      raw: ev("before_agent_start"),
      expect: { kind: "userPromptSubmit", sessionId: SESSION },
    },
    {
      name: "tool_execution_start → preToolUse carrying the tool name",
      raw: ev("tool_execution_start", { tool: "write", toolCallId: "call_1" }),
      expect: { kind: "preToolUse", toolName: "write" },
    },
    {
      name: "tool_execution_start for the plan tool → planProposal (the awaiting-plan edge)",
      raw: ev("tool_execution_start", { tool: "crafty_submit_plan", toolCallId: "call_2" }),
      expect: { kind: "planProposal", toolName: "crafty_submit_plan", planText: undefined },
    },
    {
      name: "tool_execution_end → postToolUse",
      raw: ev("tool_execution_end", { tool: "write", toolCallId: "call_1" }),
      expect: { kind: "postToolUse", toolName: "write" },
    },
    {
      name: "file_changed → fileChanged",
      raw: ev("file_changed", { tool: "write", file: "hello.txt" }),
      expect: { kind: "fileChanged", toolName: "write" },
    },
    {
      name: "agent_settled → stop",
      raw: ev("agent_settled"),
      expect: { kind: "stop", sessionId: SESSION },
    },
    {
      name: "crafty.plan.submitted → planProposal carrying the plan markdown",
      raw: ev("crafty.plan.submitted", {}, { plan_markdown: "do the thing" }),
      expect: { kind: "planProposal", planText: "do the thing" },
    },
    {
      name: "an event with no session is dropped",
      raw: { type: "agent_settled", properties: { sessionId: "" } },
      expect: null,
    },
  ]);
});
