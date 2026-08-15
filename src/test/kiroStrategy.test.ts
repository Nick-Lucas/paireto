import { KiroStrategy } from "../harness/KiroStrategy.js";
import type { KiroHookEvent } from "../harness/KiroStrategy.js";
import { runMapperFixtures } from "./harnessFixtures.js";

const base = {
  session_id: "c676fce0-ccd1-4bf5-b434-bc338e808076",
  cwd: "/proj",
};

suite("KiroStrategy mapper fixtures", () => {
  const kiro = new KiroStrategy();

  runMapperFixtures(kiro, [
    {
      name: "agentSpawn maps to sessionStart",
      raw: { ...base, hook_event_name: "agentSpawn" } as KiroHookEvent,
      expect: { kind: "sessionStart", harness: "kiro", sessionId: base.session_id },
    },
    {
      name: "userPromptSubmit maps to userPromptSubmit",
      raw: { ...base, hook_event_name: "userPromptSubmit", prompt: "Make a plan" } as KiroHookEvent,
      expect: { kind: "userPromptSubmit" },
    },
    {
      name: "write tool aliases are edit tools",
      raw: {
        ...base,
        hook_event_name: "postToolUse",
        tool_name: "fsWrite",
        tool_input: { path: "note.txt" },
        tool_response: "ok",
      } as KiroHookEvent,
      expect: { kind: "postToolUse", toolName: "fsWrite", isEditTool: true },
    },
    {
      name: "switch_to_execution carries the exact native plan",
      raw: {
        ...base,
        hook_event_name: "preToolUse",
        tool_name: "switch_to_execution",
        tool_input: { plan: "# Plan\n\n1. Add Kiro support.\n2. Test it." },
      } as KiroHookEvent,
      expect: {
        kind: "planProposal",
        toolName: "switch_to_execution",
        planText: "# Plan\n\n1. Add Kiro support.\n2. Test it.",
        isEditTool: false,
      },
    },
    {
      name: "switch_to_execution without a plan remains a tool event",
      raw: {
        ...base,
        hook_event_name: "preToolUse",
        tool_name: "switch_to_execution",
        tool_input: {},
      } as KiroHookEvent,
      expect: { kind: "preToolUse", planText: undefined },
    },
    {
      name: "postFileSave maps to fileChanged",
      raw: {
        ...base,
        hook_event_name: "postFileSave",
        file_path: "/proj/note.txt",
      } as KiroHookEvent,
      expect: { kind: "fileChanged" },
    },
    {
      name: "stop maps to stop",
      raw: {
        ...base,
        hook_event_name: "stop",
        assistant_response: "Done.",
      } as KiroHookEvent,
      expect: { kind: "stop", backgroundTaskCount: 0, sessionCronCount: 0 },
    },
    {
      name: "an unknown event is dropped",
      raw: { ...base, hook_event_name: "unknown" } as unknown as KiroHookEvent,
      expect: null,
    },
  ]);
});
