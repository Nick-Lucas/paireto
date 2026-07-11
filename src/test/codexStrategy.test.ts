// Codex mapper fixture suite, built from the EXACT empirically-pinned payloads (codex-cli 0.144.1;
// see the adapter empirical notes). The mapper is the one compile-time-unsound seam (method
// bivariance narrows the wire union to Codex's dialect), so these fixtures are the safety net:
// every kind, the plan-proposal edge (Stop-in-plan-mode with the adapter-injected plan_markdown),
// the isEditTool=apply_patch classification, and the dropped-event cases.

import { CodexStrategy } from "../harness/CodexStrategy.js";
import type { CodexHookEvent } from "../harness/CodexStrategy.js";
import { runMapperFixtures } from "./harnessFixtures.js";

// Common fields present on EVERY Codex event (session_id is a UUIDv7, NOT thread_id).
const base = {
  session_id: "019f4e06-0000-7000-8000-000000000001",
  transcript_path: "/sessions/2026/07/10/rollout-x.jsonl",
  cwd: "/proj",
  model: "gpt-5.6-sol",
  permission_mode: "bypassPermissions" as const,
};

suite("CodexStrategy mapper fixtures", () => {
  const codex = new CodexStrategy();

  runMapperFixtures(codex, [
    {
      name: "SessionStart → sessionStart",
      raw: { ...base, hook_event_name: "SessionStart", source: "startup" } as CodexHookEvent,
      expect: { kind: "sessionStart", harness: "codex", sessionId: base.session_id },
    },
    {
      name: "UserPromptSubmit → userPromptSubmit",
      raw: {
        ...base,
        hook_event_name: "UserPromptSubmit",
        turn_id: "019f4e06-0000-7000-8000-0000000000a1",
        prompt: "Use the update_plan tool",
      } as CodexHookEvent,
      expect: { kind: "userPromptSubmit" },
    },
    {
      name: "PreToolUse Bash → preToolUse, isEditTool false (shell is the Claude-style name)",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
        tool_use_id: "exec-fabf39ac",
      } as CodexHookEvent,
      expect: { kind: "preToolUse", toolName: "Bash", isEditTool: false },
    },
    {
      name: "PreToolUse apply_patch → preToolUse, isEditTool true",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "apply_patch",
        tool_input: { command: "*** Begin Patch\n*** Add File: note.txt\n+hi\n*** End Patch" },
        tool_use_id: "exec-0149",
      } as CodexHookEvent,
      expect: { kind: "preToolUse", toolName: "apply_patch", isEditTool: true },
    },
    {
      name: "PreToolUse update_plan → preToolUse, isEditTool false",
      raw: {
        ...base,
        hook_event_name: "PreToolUse",
        tool_name: "update_plan",
        tool_input: { plan: [{ step: "inspect", status: "in_progress" }] },
        tool_use_id: "exec-3741660f",
      } as CodexHookEvent,
      expect: { kind: "preToolUse", toolName: "update_plan", isEditTool: false },
    },
    {
      name: "PostToolUse apply_patch → postToolUse, isEditTool true",
      raw: {
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_response: "Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess.",
        tool_use_id: "exec-0149",
      } as CodexHookEvent,
      expect: { kind: "postToolUse", isEditTool: true },
    },
    {
      name: "PermissionRequest → permissionRequest (TUI-only awaiting-permission edge)",
      raw: { ...base, hook_event_name: "PermissionRequest" } as CodexHookEvent,
      expect: { kind: "permissionRequest" },
    },
    {
      name: "SubagentStart → subagentStart",
      raw: { ...base, hook_event_name: "SubagentStart" } as CodexHookEvent,
      expect: { kind: "subagentStart" },
    },
    {
      name: "SubagentStop → subagentStop",
      raw: { ...base, hook_event_name: "SubagentStop" } as CodexHookEvent,
      expect: { kind: "subagentStop" },
    },
    {
      name: "Stop (normal) → stop, no plan text, zero background counts",
      raw: {
        ...base,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "done",
      } as CodexHookEvent,
      expect: { kind: "stop", backgroundTaskCount: 0, sessionCronCount: 0 },
    },
    {
      name: "Stop + permission_mode plan → planProposal with adapter-injected plan_markdown",
      raw: {
        ...base,
        permission_mode: "plan",
        hook_event_name: "Stop",
        stop_hook_active: false,
        plan_markdown: "- [x] inspect\n- [ ] finish _(in progress)_",
      } as CodexHookEvent,
      expect: { kind: "planProposal", planText: "- [x] inspect\n- [ ] finish _(in progress)_" },
    },
    {
      name: "an unsubscribed hook name is dropped (Codex has no Notification hook)",
      raw: { ...base, hook_event_name: "Notification" } as unknown as CodexHookEvent,
      expect: null,
    },
  ]);
});
