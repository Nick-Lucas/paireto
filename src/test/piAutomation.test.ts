// The Pi adapter's policy, exercised without a live Pi host: which tools plan mode blocks, which tool
// arguments name a mutated file, what a stop-gate answer injects, the tool schemas the extension
// advertises (derived from the same zod contract every other harness advertises), and the output
// ceiling Pi asks every tool to respect.

import * as assert from "node:assert";

import { z } from "zod";

import { GuidedReviewArgs } from "../protocol/guidedReview.js";
import {
  blocksInPlanMode,
  MAX_TOOL_RESULT_BYTES,
  MAX_TOOL_RESULT_LINES,
  mutatedPath,
  resolvePiRoot,
  stopGateInjectionReason,
  SubmitPlanArgs,
  toolSchema,
  truncateToolText,
} from "../plugins/pi/automation.js";
import { TRUNCATION_NOTICE } from "../plugins/pi/text.js";

suite("pi plan mode", () => {
  test("blocks the file-mutating built-ins while a plan is awaiting approval", () => {
    for (const tool of ["write", "edit", "powershell"]) {
      assert.strictEqual(blocksInPlanMode(true, tool), true, tool);
    }
  });

  test("leaves the read-only built-ins alone, so the agent can still research", () => {
    for (const tool of ["read", "bash", "grep", "find", "ls", "paireto_submit_plan"]) {
      assert.strictEqual(blocksInPlanMode(true, tool), false, tool);
    }
  });

  test("blocks nothing once the plan is approved", () => {
    assert.strictEqual(blocksInPlanMode(false, "write"), false);
    assert.strictEqual(blocksInPlanMode(true, undefined), false);
  });
});

suite("pi mutated path", () => {
  test("reads the path off a write or edit call", () => {
    assert.strictEqual(mutatedPath("write", { path: "hello.txt" }), "hello.txt");
    assert.strictEqual(mutatedPath("edit", { path: "src/a.ts", edits: [] }), "src/a.ts");
  });

  test("reports nothing for a tool that does not mutate a file", () => {
    assert.strictEqual(mutatedPath("read", { path: "hello.txt" }), undefined);
    assert.strictEqual(mutatedPath("bash", { command: "rm x" }), undefined);
  });

  test("reports nothing for arguments that carry no usable path", () => {
    assert.strictEqual(mutatedPath("write", {}), undefined);
    assert.strictEqual(mutatedPath("write", { path: "  " }), undefined);
    assert.strictEqual(mutatedPath("write", undefined), undefined);
  });
});

suite("pi stop-gate answer", () => {
  test("injects only an explicit block carrying feedback", () => {
    assert.strictEqual(stopGateInjectionReason({ decision: "block", reason: "fix it" }), "fix it");
  });

  test("injects nothing on allow, a blank reason, or a failed round-trip", () => {
    assert.strictEqual(stopGateInjectionReason({ decision: "allow" }), null);
    assert.strictEqual(stopGateInjectionReason({ decision: "block", reason: "  " }), null);
    assert.strictEqual(stopGateInjectionReason(undefined), null);
  });
});

suite("pi tool schemas", () => {
  test("the plan tool advertises the plan argument as required", () => {
    const schema = toolSchema(SubmitPlanArgs);
    assert.strictEqual(schema.type, "object");
    assert.deepStrictEqual(schema.required, ["plan"]);
    assert.strictEqual(
      (schema.properties?.plan as { description?: string } | undefined)?.description,
      "The full implementation plan, as markdown.",
    );
  });

  test("the guided-review tool advertises the shared contract, so no harness can drift from it", () => {
    const schema = toolSchema(GuidedReviewArgs);
    assert.deepStrictEqual(Object.keys(schema.properties ?? {}).sort(), [
      "changesets",
      "compareTo",
      "summary",
    ]);
    assert.deepStrictEqual(schema.required, ["changesets"]);
  });

  test("a string enum stays a JSON-Schema enum, which every provider accepts", () => {
    const schema = toolSchema(z.object({ kind: z.enum(["head", "ref"]) }));
    assert.deepStrictEqual(schema.properties?.kind, { type: "string", enum: ["head", "ref"] });
  });

  test("the draft marker is dropped — Pi hands `parameters` straight to the provider", () => {
    assert.strictEqual("$schema" in toolSchema(SubmitPlanArgs), false);
  });
});

suite("pi tool output truncation", () => {
  test("passes a result that fits through untouched", () => {
    assert.strictEqual(truncateToolText("short feedback"), "short feedback");
  });

  test("truncates a result past the line ceiling and says so", () => {
    const long = Array.from({ length: MAX_TOOL_RESULT_LINES + 10 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    const out = truncateToolText(long);
    assert.ok(out.includes(TRUNCATION_NOTICE));
    assert.strictEqual(
      out.split("\n")[MAX_TOOL_RESULT_LINES - 1],
      `line ${MAX_TOOL_RESULT_LINES - 1}`,
    );
  });

  test("truncates a result past the byte ceiling", () => {
    const out = truncateToolText("x".repeat(MAX_TOOL_RESULT_BYTES + 100));
    assert.ok(out.includes(TRUNCATION_NOTICE));
    assert.ok(
      Buffer.byteLength(out, "utf8") < MAX_TOOL_RESULT_BYTES + TRUNCATION_NOTICE.length + 10,
    );
  });
});

suite("pi repo root", () => {
  test("prefers the git toplevel over the agent's cwd", () => {
    assert.strictEqual(resolvePiRoot("/repo/src", "/repo"), "/repo");
  });

  test("falls back to the cwd when the agent is not in a repository", () => {
    assert.strictEqual(resolvePiRoot("/repo/src", undefined), "/repo/src");
  });

  test("refuses a root that names no project", () => {
    assert.strictEqual(resolvePiRoot(undefined, undefined), null);
    assert.strictEqual(resolvePiRoot("relative/path", undefined), null);
    assert.strictEqual(resolvePiRoot("/", "/"), null);
  });
});
