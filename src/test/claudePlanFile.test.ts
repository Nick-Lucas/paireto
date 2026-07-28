// Claude Code writes its plan to a file and then calls ExitPlanMode; repeating the markdown in the
// tool arguments is optional and the model often omits it (verified in recorded live API traffic: the
// tool call streams `input:{}`, and the CLI back-fills `{plan, planFilePath}` from the file
// afterwards, past the point where our PermissionRequest hook fires).
//
// These tests pin that the same recovery works for a real user, whose CLAUDE_CONFIG_DIR is unset, and
// that it stays bound to this turn's plan within the shared plans directory.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const planFile = require("../../plugins/claude-code/scripts/plan-file.js") as {
  PLAN_FILE_MAX_AGE_MS: number;
  claudePlansDir: (env: NodeJS.ProcessEnv) => string | undefined;
  resolvePlanMarkdown: (
    event: unknown,
    env?: NodeJS.ProcessEnv,
    nowMs?: number,
  ) => string | undefined;
};

const PLAN = "# Plan\n\n1. Add hello.txt containing 'hi'\n";

function makeHome(): { home: string; plansDir: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pai-plans-"));
  const plansDir = path.join(home, ".claude", "plans");
  fs.mkdirSync(plansDir, { recursive: true });
  return { home, plansDir, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function writePlan(dir: string, name: string, text: string, ageMs = 0): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }
  return file;
}

suite("Claude plan-file recovery", () => {
  test("resolves the plans directory from HOME when CLAUDE_CONFIG_DIR is unset (the real-user case)", () => {
    assert.strictEqual(
      planFile.claudePlansDir({ HOME: "/home/dev" }),
      path.join("/home/dev", ".claude", "plans"),
    );
  });

  test("prefers CLAUDE_CONFIG_DIR when it is set (the E2E sandbox case)", () => {
    assert.strictEqual(
      planFile.claudePlansDir({ HOME: "/home/dev", CLAUDE_CONFIG_DIR: "/tmp/sandbox" }),
      path.join("/tmp/sandbox", "plans"),
    );
  });

  test("returns nothing when the tool call already carried the plan", () => {
    const { home, plansDir, cleanup } = makeHome();
    try {
      writePlan(plansDir, "plan-other.md", "# A different plan\n");
      const recovered = planFile.resolvePlanMarkdown(
        { tool_input: { plan: PLAN } },
        { HOME: home },
        Date.now(),
      );
      assert.strictEqual(recovered, undefined);
    } finally {
      cleanup();
    }
  });

  test("recovers the plan named by planFilePath, even outside the plans directory", () => {
    const { home, cleanup } = makeHome();
    try {
      const elsewhere = writePlan(home, "plan-named.md", PLAN);
      const recovered = planFile.resolvePlanMarkdown(
        { tool_input: { planFilePath: elsewhere } },
        { HOME: home },
        Date.now(),
      );
      assert.strictEqual(recovered, PLAN);
    } finally {
      cleanup();
    }
  });

  test("recovers a just-written plan with NO CLAUDE_CONFIG_DIR and empty tool arguments", () => {
    const { home, plansDir, cleanup } = makeHome();
    try {
      writePlan(plansDir, "plan-fresh.md", PLAN);
      const recovered = planFile.resolvePlanMarkdown(
        { tool_input: {} },
        { HOME: home },
        Date.now(),
      );
      assert.strictEqual(recovered, PLAN);
    } finally {
      cleanup();
    }
  });

  test("ignores a stale plan file — the plans directory is shared across sessions and repos", () => {
    const { home, plansDir, cleanup } = makeHome();
    try {
      writePlan(plansDir, "plan-someone-elses.md", PLAN, planFile.PLAN_FILE_MAX_AGE_MS + 60_000);
      const recovered = planFile.resolvePlanMarkdown(
        { tool_input: {} },
        { HOME: home },
        Date.now(),
      );
      assert.strictEqual(recovered, undefined);
    } finally {
      cleanup();
    }
  });

  test("picks the newest of several fresh plan files", () => {
    const { home, plansDir, cleanup } = makeHome();
    try {
      writePlan(plansDir, "plan-older.md", "# Older plan\n", 5_000);
      writePlan(plansDir, "plan-newer.md", PLAN);
      const recovered = planFile.resolvePlanMarkdown(
        { tool_input: {} },
        { HOME: home },
        Date.now(),
      );
      assert.strictEqual(recovered, PLAN);
    } finally {
      cleanup();
    }
  });

  test("fails open (undefined) on a missing directory, blank plan, or malformed event", () => {
    const { home, plansDir, cleanup } = makeHome();
    try {
      assert.strictEqual(
        planFile.resolvePlanMarkdown({ tool_input: {} }, { HOME: "/nope/nowhere" }, Date.now()),
        undefined,
      );
      writePlan(plansDir, "plan-blank.md", "   \n");
      assert.strictEqual(
        planFile.resolvePlanMarkdown({ tool_input: {} }, { HOME: home }, Date.now()),
        undefined,
      );
      assert.strictEqual(planFile.resolvePlanMarkdown(undefined, {}, Date.now()), undefined);
      assert.strictEqual(planFile.resolvePlanMarkdown({}, {}, Date.now()), undefined);
    } finally {
      cleanup();
    }
  });
});
