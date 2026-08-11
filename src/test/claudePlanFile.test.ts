// Claude Code writes its plan to a file and then calls ExitPlanMode; repeating the markdown in the
// tool arguments is optional and the model often omits it (verified in recorded live API traffic: the
// tool call streams `input:{}`, and the CLI back-fills `{plan, planFilePath}` from the file
// afterwards, past the point where our PermissionRequest hook fires).
//
// These tests pin that recovery uses only what the event itself names — the explicit planFilePath or
// the session transcript — and never picks a plan out of the shared plans directory, which holds
// files from unrelated repositories and sessions.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolvePlanMarkdown } from "../plugins/claude-code/planFile.js";

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
  test("returns nothing when the tool call already carried the plan", () => {
    const { plansDir, cleanup } = makeHome();
    try {
      writePlan(plansDir, "plan-other.md", "# A different plan\n");
      const recovered = resolvePlanMarkdown({ tool_input: { plan: PLAN } });
      assert.strictEqual(recovered, undefined);
    } finally {
      cleanup();
    }
  });

  test("recovers the plan named by the event's planFilePath", () => {
    const { home, cleanup } = makeHome();
    try {
      const elsewhere = writePlan(home, "plan-named.md", PLAN);
      const recovered = resolvePlanMarkdown({ tool_input: { planFilePath: elsewhere } });
      assert.strictEqual(recovered, PLAN);
    } finally {
      cleanup();
    }
  });

  test("recovers the plan path written in the event's own session transcript", () => {
    const { home, plansDir, cleanup } = makeHome();
    try {
      const named = writePlan(plansDir, "plan-this-session.md", PLAN);
      const transcript = path.join(home, "session.jsonl");
      fs.writeFileSync(
        transcript,
        `${JSON.stringify({
          message: {
            content: [
              { type: "tool_use", name: "Write", input: { file_path: named, content: PLAN } },
            ],
          },
        })}\n`,
      );
      const recovered = resolvePlanMarkdown({ transcript_path: transcript, tool_input: {} });
      assert.strictEqual(recovered, PLAN);
    } finally {
      cleanup();
    }
  });

  test("does not recover an uncorrelated plan from the shared plans directory", () => {
    const { plansDir, cleanup } = makeHome();
    try {
      writePlan(plansDir, "plan-fresh.md", PLAN);
      const recovered = resolvePlanMarkdown({ tool_input: {} });
      assert.strictEqual(recovered, undefined);
    } finally {
      cleanup();
    }
  });

  test("ignores a stale plan file — the plans directory is shared across sessions and repos", () => {
    const { plansDir, cleanup } = makeHome();
    try {
      writePlan(plansDir, "plan-someone-elses.md", PLAN, 120_000);
      const recovered = resolvePlanMarkdown({ tool_input: {} });
      assert.strictEqual(recovered, undefined);
    } finally {
      cleanup();
    }
  });

  test("does not pick either of two fresh plans from unrelated sessions", () => {
    const { plansDir, cleanup } = makeHome();
    try {
      writePlan(plansDir, "plan-older.md", "# Older plan\n", 5_000);
      writePlan(plansDir, "plan-newer.md", PLAN);
      const recovered = resolvePlanMarkdown({ tool_input: {} });
      assert.strictEqual(recovered, undefined);
    } finally {
      cleanup();
    }
  });

  test("fails open (undefined) on an unreadable path, a blank plan, or a malformed event", () => {
    const { plansDir, cleanup } = makeHome();
    try {
      assert.strictEqual(
        resolvePlanMarkdown({ tool_input: { planFilePath: "/nope/nowhere.md" } }),
        undefined,
      );

      const blank = writePlan(plansDir, "plan-blank.md", "   \n");
      assert.strictEqual(resolvePlanMarkdown({ tool_input: { planFilePath: blank } }), undefined);

      assert.strictEqual(
        resolvePlanMarkdown({ transcript_path: "/nope/missing.jsonl" }),
        undefined,
      );
      assert.strictEqual(resolvePlanMarkdown(undefined), undefined);
      assert.strictEqual(resolvePlanMarkdown({}), undefined);
    } finally {
      cleanup();
    }
  });
});
