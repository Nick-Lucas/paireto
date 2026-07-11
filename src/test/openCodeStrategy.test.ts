// OpenCode mapper fixture suite, built from the forwarded-event shapes the plugin produces from the
// empirically-pinned OpenCode SDK events (opencode 1.15.10; see the adapter empirical notes). The
// mapper is the one compile-time-unsound seam (method bivariance narrows the wire union to OpenCode's
// dialect), so these fixtures are the safety net: top-level vs child (parentID) session flows, the
// child→parent routing that carries the child id as agentId, the plan-proposal edges (the opt-in
// paireto_submit_plan tool.execute.before + the blocking paireto.plan.submitted gate event), and the
// dropped-event cases.

import { OpenCodeStrategy } from "../harness/OpenCodeStrategy.js";
import type { OpenCodeForwardedEvent } from "../harness/OpenCodeStrategy.js";
import { runMapperFixtures } from "./harnessFixtures.js";

const TOP = "ses_top00000000000000000000000000";
const CHILD = "ses_child0000000000000000000000000";
const PARENT = TOP;

/** Build a forwarded event as the plugin would (properties always carries the stamped sessionID). */
function ev(
  type: OpenCodeForwardedEvent["type"],
  properties: OpenCodeForwardedEvent["properties"],
  extra: Partial<OpenCodeForwardedEvent> = {},
): OpenCodeForwardedEvent {
  return { type, properties, ...extra };
}

suite("OpenCodeStrategy mapper fixtures", () => {
  const oc = new OpenCodeStrategy();

  runMapperFixtures(oc, [
    {
      name: "session.created (no parentID) → sessionStart",
      raw: ev("session.created", { sessionID: TOP, info: { id: TOP } }),
      expect: { kind: "sessionStart", harness: "opencode", sessionId: TOP, agentId: undefined },
    },
    {
      name: "session.created (parentID) → subagentStart routed to the parent, child id as agentId",
      raw: ev("session.created", { sessionID: CHILD, info: { id: CHILD, parentID: PARENT } }),
      expect: { kind: "subagentStart", sessionId: PARENT, agentId: CHILD },
    },
    {
      name: "top-level message.updated (user) → userPromptSubmit",
      raw: ev("message.updated", { sessionID: TOP, role: "user" }),
      expect: { kind: "userPromptSubmit", sessionId: TOP },
    },
    {
      name: "message.updated (non-user role) → dropped",
      raw: ev("message.updated", { sessionID: TOP, role: "assistant" }),
      expect: null,
    },
    {
      name: "permission.updated → permissionRequest",
      raw: ev("permission.updated", { sessionID: TOP }),
      expect: { kind: "permissionRequest", sessionId: TOP },
    },
    {
      name: "permission.replied → dropped",
      raw: ev("permission.replied", { sessionID: TOP, permissionID: "perm_1", response: "once" }),
      expect: null,
    },
    {
      name: "file.edited → fileChanged",
      raw: ev("file.edited", { sessionID: TOP, file: "/proj/a.ts" }),
      expect: { kind: "fileChanged", sessionId: TOP },
    },
    {
      name: "tool.execute.before (edit) → preToolUse, isEditTool true",
      raw: ev("tool.execute.before", { sessionID: TOP, tool: "edit", callID: "call_1" }),
      expect: { kind: "preToolUse", sessionId: TOP, toolName: "edit", isEditTool: true },
    },
    {
      name: "tool.execute.before (bash) → preToolUse, isEditTool false",
      raw: ev("tool.execute.before", { sessionID: TOP, tool: "bash", callID: "call_2" }),
      expect: { kind: "preToolUse", toolName: "bash", isEditTool: false },
    },
    {
      name: "tool.execute.after (write) → postToolUse, isEditTool true",
      raw: ev("tool.execute.after", { sessionID: TOP, tool: "write", callID: "call_3" }),
      expect: { kind: "postToolUse", isEditTool: true },
    },
    {
      name: "tool.execute.before (paireto_submit_plan) → planProposal (opt-in plan edge)",
      raw: ev("tool.execute.before", {
        sessionID: TOP,
        tool: "paireto_submit_plan",
        callID: "call_4",
      }),
      expect: { kind: "planProposal", sessionId: TOP },
    },
    {
      name: "paireto.plan.submitted → planProposal with adapter-injected plan markdown",
      raw: ev("paireto.plan.submitted", { sessionID: TOP }, { plan_markdown: "# Plan\n- do it" }),
      expect: { kind: "planProposal", sessionId: TOP, planText: "# Plan\n- do it" },
    },
    {
      name: "top-level session.idle → stop",
      raw: ev("session.idle", { sessionID: TOP, info: { id: TOP } }),
      expect: { kind: "stop", sessionId: TOP, backgroundTaskCount: 0, sessionCronCount: 0 },
    },
    {
      name: "top-level session.deleted → sessionEnd",
      raw: ev("session.deleted", { sessionID: TOP, info: { id: TOP } }),
      expect: { kind: "sessionEnd", sessionId: TOP },
    },
    {
      name: "child tool.execute.before → routed to parent, child id as agentId",
      raw: ev(
        "tool.execute.before",
        { sessionID: CHILD, tool: "bash", callID: "call_5" },
        { parentSessionID: PARENT },
      ),
      expect: { kind: "preToolUse", sessionId: PARENT, agentId: CHILD, toolName: "bash" },
    },
    {
      name: "child session.idle → subagentStop (parent row, child id as agentId)",
      raw: ev(
        "session.idle",
        { sessionID: CHILD, info: { id: CHILD } },
        { parentSessionID: PARENT },
      ),
      expect: { kind: "subagentStop", sessionId: PARENT, agentId: CHILD },
    },
    {
      name: "child session.deleted → subagentStop",
      raw: ev(
        "session.deleted",
        { sessionID: CHILD, info: { id: CHILD } },
        { parentSessionID: PARENT },
      ),
      expect: { kind: "subagentStop", sessionId: PARENT, agentId: CHILD },
    },
    {
      name: "session.updated → dropped (bookkeeping only)",
      raw: ev("session.updated", { sessionID: TOP }),
      expect: null,
    },
    {
      name: "session.error → dropped",
      raw: ev("session.error", { sessionID: TOP }),
      expect: null,
    },
    {
      name: "an event with no resolvable sessionID is dropped",
      raw: ev("file.edited", { file: "/proj/a.ts" }),
      expect: null,
    },
  ]);
});
