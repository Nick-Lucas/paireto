// The `paireto_review` tool is agent-facing contract: the model decides whether to call it from the
// name and description alone, and the e2e replay fixtures match on that text. Pin both so a reword
// is a deliberate change with a fixture re-record, not an accident.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  REVIEW_TOOL_DESCRIPTION,
  REVIEW_TOOL_INPUT_SCHEMA,
  REVIEW_TOOL_NAME,
  runReview,
  textResult,
} from "../plugins/core/mcp/reviewTool.js";

suite("MCP paireto_review tool", () => {
  test("the tool name is the one the skills and commands invoke", () => {
    assert.strictEqual(REVIEW_TOOL_NAME, "paireto_review");
  });

  test("the description is unchanged", () => {
    assert.strictEqual(
      REVIEW_TOOL_DESCRIPTION,
      "Open an interactive code review in the connected VS Code window and wait for the user to " +
        "submit feedback. Blocks until the user clicks Send Feedback or Cancel, then returns the " +
        "review comments (file:line, kind, note) to act on. Call this when the user asks for a review.",
    );
  });

  test("the tool takes no arguments", () => {
    assert.deepStrictEqual(REVIEW_TOOL_INPUT_SCHEMA, {});
  });

  test("textResult marks errors and leaves successes unmarked", () => {
    assert.deepStrictEqual(textResult("hello"), {
      content: [{ type: "text", text: "hello" }],
    });
    assert.deepStrictEqual(textResult("nope", true), {
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
  });

  test("with no window listening the tool reports an error rather than hanging", async () => {
    const result = await runReview(undefined);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /No VS Code Paireto is listening/);
  });

  test("a socket that is not there reports no window rather than a connection failure", async () => {
    const result = await runReview({
      target: { socketPath: "/nonexistent/nope.sock", repoRoot: "/tmp" },
      cwd: "/tmp",
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /No VS Code Paireto is listening/);
  });

  test("a path that exists but is not a listening socket reports a connection failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-review-"));
    const notASocket = path.join(dir, "not.sock");
    fs.writeFileSync(notASocket, "");
    try {
      const result = await runReview({
        target: { socketPath: notASocket, repoRoot: dir },
        cwd: dir,
      });
      assert.strictEqual(result.isError, true);
      assert.match(result.content[0].text, /Could not connect/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
