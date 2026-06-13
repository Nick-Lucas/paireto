import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { canonicalize, repoKey } from "../protocol/paths.js";
import { parseWorktrees } from "../git/WorktreeService.js";
import { parseNameStatus } from "../git/DiffService.js";
import { renderPlanFeedback } from "../plan/planFeedback.js";
import { renderReviewFeedback } from "../review/reviewFeedback.js";
import type { ReviewComment } from "../review/reviewTypes.js";

suite("repoKey", () => {
  test("is deterministic and 16 hex chars", () => {
    const a = repoKey("/Users/x/dev/repo");
    const b = repoKey("/Users/x/dev/repo");
    assert.strictEqual(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  test("ignores a trailing slash", () => {
    assert.strictEqual(repoKey("/Users/x/dev/repo"), repoKey("/Users/x/dev/repo/"));
  });

  test("differs for different paths", () => {
    assert.notStrictEqual(repoKey("/Users/x/a"), repoKey("/Users/x/b"));
  });

  test("resolves symlinks identically (the /var trap)", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "tui-key-"));
    const real = path.join(base, "real-repo");
    const link = path.join(base, "link-repo");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link);
    try {
      assert.strictEqual(repoKey(link), repoKey(real));
      assert.strictEqual(canonicalize(link), canonicalize(real));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

suite("parseWorktrees", () => {
  test("parses NUL-record porcelain with main + detached", () => {
    const z =
      "worktree /a\0HEAD abc\0branch refs/heads/main\0\0" + "worktree /b\0HEAD def\0detached\0\0";
    const result = parseWorktrees(z);
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(
      { path: result[0].path, branch: result[0].branch, isMain: result[0].isMain },
      { path: "/a", branch: "main", isMain: true },
    );
    assert.strictEqual(result[1].detached, true);
    assert.strictEqual(result[1].isMain, false);
  });
});

suite("parseNameStatus", () => {
  test("parses modify, rename (two paths), add", () => {
    const z = "M\0src/a.ts\0R100\0old.ts\0new.ts\0A\0c.ts\0";
    const files = parseNameStatus(z);
    assert.strictEqual(files.length, 3);
    assert.deepStrictEqual(files[0], { path: "src/a.ts", status: "M" });
    assert.deepStrictEqual(files[1], { path: "new.ts", oldPath: "old.ts", status: "R" });
    assert.deepStrictEqual(files[2], { path: "c.ts", status: "A" });
  });
});

suite("renderPlanFeedback", () => {
  test("orders blocking before suggestion and omits notes", () => {
    const out = renderPlanFeedback([
      { line: 5, quote: "do X", body: "make it Y", severity: "suggestion" },
      { line: 1, quote: "do Z", body: "must not Z", severity: "blocking" },
      { line: 9, quote: "fyi", body: "ignore me", severity: "note" },
    ]);
    assert.ok(out.includes("NOT APPROVED"));
    assert.ok(out.indexOf("[BLOCKING]") < out.indexOf("[SUGGESTION]"));
    assert.ok(!out.includes("ignore me"));
    assert.ok(out.includes("(1 blocking, 1 suggestion)"));
  });
});

suite("renderReviewFeedback", () => {
  const mk = (over: Partial<ReviewComment>): ReviewComment => ({
    id: "x",
    filePath: "src/a.ts",
    side: "modified",
    line: 0,
    severity: "suggestion",
    body: "fix",
    resolved: false,
    quote: "line",
    anchor: { lineText: "line", contextBefore: [], contextAfter: [], lineHash: "h" },
    ...over,
  });

  test("excludes resolved and note comments", () => {
    const out = renderReviewFeedback([
      mk({ severity: "note", body: "note-only" }),
      mk({ resolved: true, body: "resolved-only" }),
      mk({ severity: "blocking", body: "real-issue", line: 41 }),
    ]);
    assert.ok(out.includes("real-issue"));
    assert.ok(!out.includes("note-only"));
    assert.ok(!out.includes("resolved-only"));
    assert.ok(out.includes("src/a.ts:42"));
  });

  test("returns empty when nothing actionable", () => {
    assert.strictEqual(renderReviewFeedback([mk({ severity: "note" })]), "");
  });
});
