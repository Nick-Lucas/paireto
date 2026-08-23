import * as assert from "node:assert";

import { KiroStrategy } from "../harness/KiroStrategy.js";
import type { KiroHookEvent } from "../harness/KiroStrategy.js";
import { runMapperFixtures } from "./harnessFixtures.js";

// Shaped like a real payload: Kiro spells its session id `sess_<uuid>` and its `hook_event_name` in
// the canonical PascalCase it normalizes every accepted trigger spelling to.
const base = {
  session_id: "sess_c676fce0-ccd1-4bf5-b434-bc338e808076",
  cwd: "/proj",
};

suite("KiroStrategy mapper fixtures", () => {
  const kiro = new KiroStrategy();

  runMapperFixtures(kiro, [
    {
      name: "SessionStart maps to sessionStart",
      raw: { ...base, hook_event_name: "SessionStart" } as KiroHookEvent,
      expect: { kind: "sessionStart", harness: "kiro", sessionId: base.session_id },
    },
    {
      name: "UserPromptSubmit maps to userPromptSubmit",
      raw: { ...base, hook_event_name: "UserPromptSubmit", prompt: "Make a plan" } as KiroHookEvent,
      expect: { kind: "userPromptSubmit" },
    },
    {
      name: "write tool aliases are edit tools",
      raw: {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "fs_write",
        tool_input: { path: "note.txt" },
        tool_response: "ok",
      } as KiroHookEvent,
      expect: { kind: "postToolUse", toolName: "fs_write", isEditTool: true },
    },
    {
      // Kiro classifies these as fs_write too, and a turn only earns a review when it changed files.
      name: "an in-place edit is an edit tool",
      raw: {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "str_replace",
        tool_input: { path: "note.txt" },
      } as KiroHookEvent,
      expect: { kind: "postToolUse", toolName: "str_replace", isEditTool: true },
    },
    {
      name: "a shell command is not an edit tool",
      raw: {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "execute_bash",
        tool_input: { command: "ls" },
      } as KiroHookEvent,
      expect: { kind: "postToolUse", toolName: "execute_bash", isEditTool: false },
    },
    {
      name: "switch_to_execution carries the exact native plan",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
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
        hook_event_name: "PreToolUse",
        tool_name: "switch_to_execution",
        tool_input: {},
      } as KiroHookEvent,
      expect: { kind: "preToolUse", planText: undefined },
    },
    {
      name: "PostFileSave maps to fileChanged",
      raw: {
        ...base,
        hook_event_name: "PostFileSave",
        file_path: "/proj/note.txt",
      } as KiroHookEvent,
      expect: { kind: "fileChanged" },
    },
    {
      name: "Stop maps to stop",
      raw: {
        ...base,
        hook_event_name: "Stop",
      } as KiroHookEvent,
      expect: { kind: "stop", backgroundTaskCount: 0, sessionCronCount: 0 },
    },
    {
      // The camelCase spelling a hook FILE may use is normalized by Kiro before the command runs, so
      // a payload that still carries it is not something this mapper should accept.
      name: "the pre-normalization spelling is dropped",
      raw: { ...base, hook_event_name: "agentSpawn" } as unknown as KiroHookEvent,
      expect: null,
    },
    {
      name: "an unknown event is dropped",
      raw: { ...base, hook_event_name: "unknown" } as unknown as KiroHookEvent,
      expect: null,
    },
  ]);
});

// Approving a plan starts the turn that implements it, and that turn ends without a Stop hook, so
// the review it should end in has to be asked for while the turn is still running. Kiro only feeds a
// hook's stdout to the agent on SessionStart and UserPromptSubmit, which is why the ask waits for a
// prompt rather than going out on the first event after the approval.
suite("KiroStrategy turn instruction", () => {
  const kiro = new KiroStrategy();
  const askOn = (
    hook_event_name: KiroHookEvent["hook_event_name"],
    planApprovedAwaitingReview: boolean,
  ): string | undefined =>
    kiro.turnInstruction({ ...base, hook_event_name } as KiroHookEvent, {
      planApprovedAwaitingReview,
    });

  test("an approved plan's implementation turn is told to open the review", () => {
    const instruction = askOn("UserPromptSubmit", true);
    assert.ok(instruction?.includes("paireto_review"), "names the tool to call");
  });

  test("no instruction without an approved plan waiting for its review", () => {
    assert.strictEqual(askOn("UserPromptSubmit", false), undefined);
  });

  test("events that cannot carry text back get none", () => {
    for (const event of ["PreToolUse", "PostToolUse", "Stop", "PostFileSave"] as const) {
      assert.strictEqual(askOn(event, true), undefined, `${event} carries no instruction`);
    }
  });
});
