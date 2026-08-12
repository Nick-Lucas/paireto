// Unit coverage for the OpenCode adapter's PURE automation helpers. Covers the three surfaces the
// automation layer decides on: config mutation (incl. the permission spread hazard), planning-prompt
// gating (planning-agent / subagent / title-generator cases), and the post-hoc stop-gate decision.
//
// The built adapter bundle has its own contract — every export loader-safe — which pluginBundles
// asserts against the artifact the installer copies.

import * as assert from "node:assert";

import {
  agentModeFor,
  applyOpenCodeConfig,
  getLastUserAgentFromMessages,
  isChildSession,
  isNewUserTurn,
  isTitleGeneratorPrompt,
  normalizePrimaryTools,
  resolveOpenCodeRoot,
  shouldInjectPlanningPrompt,
  stopGateInjectionReason,
} from "../plugins/opencode/automation.js";
import type { OpenCodeConfig } from "../plugins/opencode/types.js";

function permissionOf(config: OpenCodeConfig, agent: string): Record<string, unknown> {
  return (config.agent?.[agent]?.permission ?? {}) as Record<string, unknown>;
}

suite("OpenCode adapter automation helpers", () => {
  suite("resolveOpenCodeRoot (Git and non-Git workspaces)", () => {
    test("prefers the real worktree root when OpenCode supplies one", () => {
      assert.strictEqual(
        resolveOpenCodeRoot("/workspace/repo", "/workspace/repo/packages/api"),
        "/workspace/repo",
      );
    });

    test("uses the exact OpenCode directory when there is no Git worktree", () => {
      assert.strictEqual(resolveOpenCodeRoot("/", "/workspace/non-git"), "/workspace/non-git");
    });

    test("rejects missing or relative fallback directories", () => {
      assert.strictEqual(resolveOpenCodeRoot("/", undefined), null);
      assert.strictEqual(resolveOpenCodeRoot("/", "relative/path"), null);
    });
  });

  suite("applyOpenCodeConfig (plan-tool scoping)", () => {
    test("empty config: adds the tool to primary_tools, allows plan, denies build", () => {
      const config: OpenCodeConfig = {};
      applyOpenCodeConfig(config, ["plan"]);
      assert.deepStrictEqual(config.experimental?.primary_tools, ["paireto_submit_plan"]);
      assert.strictEqual(permissionOf(config, "plan").paireto_submit_plan, "allow");
      assert.strictEqual(permissionOf(config, "build").paireto_submit_plan, "deny");
    });

    test("preserves + dedups existing primary_tools, never duplicating the tool", () => {
      const config: OpenCodeConfig = {
        experimental: { primary_tools: ["foo", "foo", "paireto_submit_plan"] },
      };
      applyOpenCodeConfig(config, ["plan"]);
      assert.deepStrictEqual(config.experimental?.primary_tools, ["foo", "paireto_submit_plan"]);
    });

    test("permission spread hazard: existing per-tool entries survive (in-place, never spread)", () => {
      const config: OpenCodeConfig = {
        agent: { plan: { permission: { edit: "allow", bash: "ask" } } },
      };
      applyOpenCodeConfig(config, ["plan"]);
      const perm = permissionOf(config, "plan");
      assert.strictEqual(perm.edit, "allow", "edit preserved");
      assert.strictEqual(perm.bash, "ask", "bash preserved");
      assert.strictEqual(perm.paireto_submit_plan, "allow");
    });

    test("permission spread hazard: a malformed (string) permission is reset to a usable object", () => {
      const config: OpenCodeConfig = { agent: { plan: { permission: "allow" } } };
      applyOpenCodeConfig(config, ["plan"]);
      assert.deepStrictEqual(config.agent?.plan.permission, { paireto_submit_plan: "allow" });
    });

    test("a declared subagent is NOT denied (it never sees the primary-only tool)", () => {
      const config: OpenCodeConfig = { agent: { helper: { mode: "subagent" } } };
      applyOpenCodeConfig(config, ["plan"]);
      assert.strictEqual(permissionOf(config, "helper").paireto_submit_plan, undefined);
    });

    test("a declared non-planning primary agent IS denied", () => {
      const config: OpenCodeConfig = { agent: { reviewer: { mode: "primary" }, freeform: {} } };
      applyOpenCodeConfig(config, ["plan"]);
      assert.strictEqual(permissionOf(config, "reviewer").paireto_submit_plan, "deny");
      assert.strictEqual(permissionOf(config, "freeform").paireto_submit_plan, "deny");
    });

    test("a custom planning agent is allowed (and not re-denied by the build sweep)", () => {
      const config: OpenCodeConfig = { agent: { architect: {} } };
      applyOpenCodeConfig(config, ["plan", "architect"]);
      assert.strictEqual(permissionOf(config, "architect").paireto_submit_plan, "allow");
      assert.strictEqual(permissionOf(config, "plan").paireto_submit_plan, "allow");
    });

    test("idempotent: running twice yields the same config", () => {
      const once: OpenCodeConfig = { agent: { build: {}, reviewer: { mode: "primary" } } };
      applyOpenCodeConfig(once, ["plan"]);
      const snapshot = JSON.stringify(once);
      applyOpenCodeConfig(once, ["plan"]);
      assert.strictEqual(JSON.stringify(once), snapshot);
    });
  });

  suite("normalizePrimaryTools", () => {
    test("non-array reads as empty; strings are trimmed + deduped, non-strings dropped", () => {
      assert.deepStrictEqual(normalizePrimaryTools(undefined), []);
      assert.deepStrictEqual(normalizePrimaryTools("nope"), []);
      assert.deepStrictEqual(normalizePrimaryTools([" a ", "a", 3, "", "b"]), ["a", "b"]);
    });
  });

  suite("planning-prompt gating", () => {
    test("getLastUserAgentFromMessages returns the last user message's agent", () => {
      const messages = [
        { info: { role: "user", agent: "build" } },
        { info: { role: "assistant" } },
        { info: { role: "user", agent: "plan" } },
        { info: { role: "assistant", agent: "ignored" } },
      ];
      assert.strictEqual(getLastUserAgentFromMessages(messages), "plan");
    });

    test("getLastUserAgentFromMessages: undefined when no user agent / bad input", () => {
      assert.strictEqual(getLastUserAgentFromMessages(undefined), undefined);
      assert.strictEqual(
        getLastUserAgentFromMessages([{ info: { role: "assistant" } }]),
        undefined,
      );
      assert.strictEqual(getLastUserAgentFromMessages([{ info: { role: "user" } }]), undefined);
    });

    test("agentModeFor reads the named agent's mode, or undefined", () => {
      const agents = [
        { name: "plan", mode: "primary" },
        { name: "helper", mode: "subagent" },
      ];
      assert.strictEqual(agentModeFor("helper", agents), "subagent");
      assert.strictEqual(agentModeFor("plan", agents), "primary");
      assert.strictEqual(agentModeFor("missing", agents), undefined);
      assert.strictEqual(agentModeFor("plan", undefined), undefined);
    });

    test("isTitleGeneratorPrompt matches the internal title prompts (case-insensitive)", () => {
      assert.ok(isTitleGeneratorPrompt("You are a TITLE GENERATOR."));
      assert.ok(isTitleGeneratorPrompt("Please generate a title for this chat."));
      assert.strictEqual(isTitleGeneratorPrompt("You are a coding agent."), false);
      assert.strictEqual(isTitleGeneratorPrompt(""), false);
    });

    const base = { isTitleGenerator: false, isSubagent: false, planningAgents: ["plan"] };
    test("injects for a resolved planning agent", () => {
      assert.strictEqual(shouldInjectPlanningPrompt({ ...base, agentName: "plan" }), true);
    });
    test("does NOT inject for a non-planning agent", () => {
      assert.strictEqual(shouldInjectPlanningPrompt({ ...base, agentName: "build" }), false);
    });
    test("does NOT inject for a subagent, even a planning-named one", () => {
      assert.strictEqual(
        shouldInjectPlanningPrompt({ ...base, agentName: "plan", isSubagent: true }),
        false,
      );
    });
    test("does NOT inject into the title-generator prompt", () => {
      assert.strictEqual(
        shouldInjectPlanningPrompt({ ...base, agentName: "plan", isTitleGenerator: true }),
        false,
      );
    });
    test("does NOT inject when the agent is unresolved", () => {
      assert.strictEqual(shouldInjectPlanningPrompt({ ...base, agentName: undefined }), false);
    });
  });

  suite("stop-gate decision", () => {
    test("stopGateInjectionReason: block + non-empty reason injects that reason", () => {
      assert.strictEqual(
        stopGateInjectionReason({ decision: "block", reason: "fix the bug" }),
        "fix the bug",
      );
    });
    test("stopGateInjectionReason: allow / blank reason / fallback / malformed inject nothing", () => {
      assert.strictEqual(stopGateInjectionReason({ decision: "allow", reason: "x" }), null);
      assert.strictEqual(stopGateInjectionReason({ decision: "block", reason: "  " }), null);
      assert.strictEqual(stopGateInjectionReason({ decision: "block" }), null);
      // The message arrives off a socket, so a null body is reachable at runtime even though the
      // type says otherwise.
      assert.strictEqual(stopGateInjectionReason(null as never), null);
      assert.strictEqual(stopGateInjectionReason(undefined), null);
    });

    test("isNewUserTurn: a user message is a turn-start only on FIRST sight of its id", () => {
      // OpenCode re-fires message.updated for the SAME user message at turn end; a second forward
      // would reset changedThisTurn AFTER the turn's edits and hide them from the turn-end review.
      const seen = new Set<string>();
      assert.strictEqual(isNewUserTurn(seen, { role: "user", id: "msg_1" }), true);
      assert.strictEqual(
        isNewUserTurn(seen, { role: "user", id: "msg_1" }),
        false,
        "the turn-end re-fire of the same message is NOT a new turn",
      );
      assert.strictEqual(
        isNewUserTurn(seen, { role: "user", id: "msg_2" }),
        true,
        "a genuinely new user message (new id) is a new turn",
      );
    });

    test("isNewUserTurn: non-user roles are never a turn-start; an id-less user msg still forwards", () => {
      const seen = new Set<string>();
      assert.strictEqual(isNewUserTurn(seen, { role: "assistant", id: "a1" }), false);
      assert.strictEqual(isNewUserTurn(seen, {}), false);
      // No id to dedup on → fail toward forwarding (can't tell a re-fire, so treat as a turn-start).
      assert.strictEqual(isNewUserTurn(seen, { role: "user" }), true);
      assert.strictEqual(isNewUserTurn(seen, { role: "user" }), true);
    });

    test("isChildSession: true only for a session known to have a parent", () => {
      const parentOf = new Map<string, string>([["child", "parent"]]);
      assert.strictEqual(isChildSession("child", parentOf), true);
      assert.strictEqual(isChildSession("parent", parentOf), false);
      assert.strictEqual(isChildSession(undefined, parentOf), false);
      assert.strictEqual(isChildSession("child", undefined), false);
    });
  });
});
