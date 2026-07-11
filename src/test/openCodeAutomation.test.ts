// Unit coverage for the OpenCode adapter's PURE automation helpers (plugins/opencode/paireto.js).
// The plugin is a plain ES module shipped verbatim to the user's OpenCode config dir, so these
// helpers can't be imported through the TS graph — the test dynamic-imports the real .js file (the
// same artifact the installer copies) and exercises the exported decision functions with no live
// OpenCode host. Covers the three surfaces the automation layer decides on: config mutation (incl.
// the permission spread hazard), planning-prompt gating (planning-agent / subagent / title-generator
// cases), and the post-hoc stop-gate decision.

import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const pluginPath = path.resolve(__dirname, "../../plugins/opencode/paireto.js");

// The plugin is plain JS with no type surface — the dynamic import resolves to `any`.
let mod: any;

suite("OpenCode adapter automation helpers", () => {
  suiteSetup(async () => {
    mod = await import(pathToFileURL(pluginPath).href);
  });

  suite("applyOpenCodeConfig (plan-tool scoping)", () => {
    test("empty config: adds the tool to primary_tools, allows plan, denies build", () => {
      const config: Record<string, unknown> = {};
      mod.applyOpenCodeConfig(config, ["plan"]);
      assert.deepStrictEqual(
        (config.experimental as { primary_tools: string[] }).primary_tools,
        ["paireto_submit_plan"],
      );
      const agent = config.agent as Record<string, { permission: Record<string, string> }>;
      assert.strictEqual(agent.plan.permission.paireto_submit_plan, "allow");
      assert.strictEqual(agent.build.permission.paireto_submit_plan, "deny");
    });

    test("preserves + dedups existing primary_tools, never duplicating the tool", () => {
      const config: Record<string, unknown> = {
        experimental: { primary_tools: ["foo", "foo", "paireto_submit_plan"] },
      };
      mod.applyOpenCodeConfig(config, ["plan"]);
      assert.deepStrictEqual(
        (config.experimental as { primary_tools: string[] }).primary_tools,
        ["foo", "paireto_submit_plan"],
      );
    });

    test("permission spread hazard: existing per-tool entries survive (in-place, never spread)", () => {
      const config: Record<string, unknown> = {
        agent: { plan: { permission: { edit: "allow", bash: "ask" } } },
      };
      mod.applyOpenCodeConfig(config, ["plan"]);
      const perm = (config.agent as Record<string, { permission: Record<string, string> }>).plan
        .permission;
      assert.strictEqual(perm.edit, "allow", "edit preserved");
      assert.strictEqual(perm.bash, "ask", "bash preserved");
      assert.strictEqual(perm.paireto_submit_plan, "allow");
    });

    test("permission spread hazard: a malformed (string) permission is reset to a usable object", () => {
      const config: Record<string, unknown> = {
        agent: { plan: { permission: "allow" } },
      };
      mod.applyOpenCodeConfig(config, ["plan"]);
      const agentPlan = (config.agent as Record<string, { permission: unknown }>).plan;
      assert.deepStrictEqual(agentPlan.permission, { paireto_submit_plan: "allow" });
    });

    test("a declared subagent is NOT denied (it never sees the primary-only tool)", () => {
      const config: Record<string, unknown> = {
        agent: { helper: { mode: "subagent" } },
      };
      mod.applyOpenCodeConfig(config, ["plan"]);
      const helper = (config.agent as Record<string, { permission?: Record<string, string> }>)
        .helper;
      assert.strictEqual(helper.permission?.paireto_submit_plan, undefined);
    });

    test("a declared non-planning primary agent IS denied", () => {
      const config: Record<string, unknown> = {
        agent: { reviewer: { mode: "primary" }, freeform: {} },
      };
      mod.applyOpenCodeConfig(config, ["plan"]);
      const agent = config.agent as Record<string, { permission: Record<string, string> }>;
      assert.strictEqual(agent.reviewer.permission.paireto_submit_plan, "deny");
      assert.strictEqual(agent.freeform.permission.paireto_submit_plan, "deny");
    });

    test("a custom planning agent is allowed (and not re-denied by the build sweep)", () => {
      const config: Record<string, unknown> = { agent: { architect: {} } };
      mod.applyOpenCodeConfig(config, ["plan", "architect"]);
      const agent = config.agent as Record<string, { permission: Record<string, string> }>;
      assert.strictEqual(agent.architect.permission.paireto_submit_plan, "allow");
      assert.strictEqual(agent.plan.permission.paireto_submit_plan, "allow");
    });

    test("idempotent: running twice yields the same config", () => {
      const once: Record<string, unknown> = { agent: { build: {}, reviewer: { mode: "primary" } } };
      mod.applyOpenCodeConfig(once, ["plan"]);
      const snapshot = JSON.stringify(once);
      mod.applyOpenCodeConfig(once, ["plan"]);
      assert.strictEqual(JSON.stringify(once), snapshot);
    });
  });

  suite("normalizePrimaryTools", () => {
    test("non-array reads as empty; strings are trimmed + deduped, non-strings dropped", () => {
      assert.deepStrictEqual(mod.normalizePrimaryTools(undefined), []);
      assert.deepStrictEqual(mod.normalizePrimaryTools("nope"), []);
      assert.deepStrictEqual(mod.normalizePrimaryTools([" a ", "a", 3, "", "b"]), ["a", "b"]);
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
      assert.strictEqual(mod.getLastUserAgentFromMessages(messages), "plan");
    });

    test("getLastUserAgentFromMessages: undefined when no user agent / bad input", () => {
      assert.strictEqual(mod.getLastUserAgentFromMessages(undefined), undefined);
      assert.strictEqual(mod.getLastUserAgentFromMessages([{ info: { role: "assistant" } }]), undefined);
      assert.strictEqual(mod.getLastUserAgentFromMessages([{ info: { role: "user" } }]), undefined);
    });

    test("agentModeFor reads the named agent's mode, or undefined", () => {
      const agents = [{ name: "plan", mode: "primary" }, { name: "helper", mode: "subagent" }];
      assert.strictEqual(mod.agentModeFor("helper", agents), "subagent");
      assert.strictEqual(mod.agentModeFor("plan", agents), "primary");
      assert.strictEqual(mod.agentModeFor("missing", agents), undefined);
      assert.strictEqual(mod.agentModeFor("plan", undefined), undefined);
    });

    test("isTitleGeneratorPrompt matches the internal title prompts (case-insensitive)", () => {
      assert.ok(mod.isTitleGeneratorPrompt("You are a TITLE GENERATOR."));
      assert.ok(mod.isTitleGeneratorPrompt("Please generate a title for this chat."));
      assert.strictEqual(mod.isTitleGeneratorPrompt("You are a coding agent."), false);
      assert.strictEqual(mod.isTitleGeneratorPrompt(""), false);
    });

    const base = { isTitleGenerator: false, isSubagent: false, planningAgents: ["plan"] };
    test("injects for a resolved planning agent", () => {
      assert.strictEqual(mod.shouldInjectPlanningPrompt({ ...base, agentName: "plan" }), true);
    });
    test("does NOT inject for a non-planning agent", () => {
      assert.strictEqual(mod.shouldInjectPlanningPrompt({ ...base, agentName: "build" }), false);
    });
    test("does NOT inject for a subagent, even a planning-named one", () => {
      assert.strictEqual(
        mod.shouldInjectPlanningPrompt({ ...base, agentName: "plan", isSubagent: true }),
        false,
      );
    });
    test("does NOT inject into the title-generator prompt", () => {
      assert.strictEqual(
        mod.shouldInjectPlanningPrompt({ ...base, agentName: "plan", isTitleGenerator: true }),
        false,
      );
    });
    test("does NOT inject when the agent is unresolved", () => {
      assert.strictEqual(mod.shouldInjectPlanningPrompt({ ...base, agentName: undefined }), false);
    });
  });

  suite("stop-gate decision", () => {
    test("stopGateInjectionReason: block + non-empty reason injects that reason", () => {
      assert.strictEqual(
        mod.stopGateInjectionReason({ decision: "block", reason: "fix the bug" }),
        "fix the bug",
      );
    });
    test("stopGateInjectionReason: allow / blank reason / fallback / malformed inject nothing", () => {
      assert.strictEqual(mod.stopGateInjectionReason({ decision: "allow", reason: "x" }), null);
      assert.strictEqual(mod.stopGateInjectionReason({ decision: "block", reason: "  " }), null);
      assert.strictEqual(mod.stopGateInjectionReason({ decision: "block" }), null);
      assert.strictEqual(mod.stopGateInjectionReason(null), null);
      assert.strictEqual(mod.stopGateInjectionReason(undefined), null);
    });

    test("isChildSession: true only for a session known to have a parent", () => {
      const parentOf = new Map<string, string>([["child", "parent"]]);
      assert.strictEqual(mod.isChildSession("child", parentOf), true);
      assert.strictEqual(mod.isChildSession("parent", parentOf), false);
      assert.strictEqual(mod.isChildSession(undefined, parentOf), false);
      assert.strictEqual(mod.isChildSession("child", undefined), false);
    });
  });

  suite("planToolArgs (submit_plan arg shape)", () => {
    // OpenCode types tool `args` as a ZodRawShape (record of zod schemas). The plan arg MUST be a
    // real schema, never a bare value (`""` throws during schema advertisement + arg validation), so
    // it's built from the SDK's zod instance (`tool.schema`), modelled here by a minimal fake.
    const fakeSchema = {
      string() {
        const s = { kind: "zodString", describe: (d: string) => ({ ...s, description: d }) };
        return s;
      },
    };

    test("builds { plan: <schema> } — a real schema, never a bare string", () => {
      const args = mod.planToolArgs(fakeSchema);
      assert.notStrictEqual(typeof args.plan, "string", "the arg must not be a bare value");
      assert.strictEqual(args.plan.kind, "zodString");
      assert.strictEqual(typeof args.plan.description, "string");
    });

    test("fail-open: no SDK zod (not under OpenCode) → empty shape, no crash", () => {
      assert.deepStrictEqual(mod.planToolArgs(null), {});
      assert.deepStrictEqual(mod.planToolArgs(undefined), {});
      assert.deepStrictEqual(mod.planToolArgs({}), {});
    });
  });
});
