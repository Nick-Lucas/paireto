import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { canonicalize, repoKey } from "../protocol/paths.js";
import { parseWorktrees } from "../git/WorktreeService.js";
import { parseNameStatus, type ChangedFile } from "../git/DiffService.js";
import { buildFileTree, filesInEntry } from "../views/fileTree.js";
import { renderPlanFeedback } from "../plan/planFeedback.js";
import { renderReviewFeedback } from "../review/reviewFeedback.js";
import type { ReviewComment } from "../review/reviewTypes.js";
import { ReviewGateRegistry } from "../review/ReviewGateRegistry.js";
import { GateCoordinator, type GateSession } from "../gate/GateCoordinator.js";
import { isStaleActive, STALE_ACTIVE_MS_FOR_TEST } from "../agents/AgentSessionService.js";

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
  test("parses modify, rename (two paths), add — tagged with group", () => {
    const z = "M\0src/a.ts\0R100\0old.ts\0new.ts\0A\0c.ts\0";
    const files = parseNameStatus(z, "staged");
    assert.strictEqual(files.length, 3);
    assert.deepStrictEqual(files[0], {
      path: "src/a.ts",
      status: "M",
      group: "staged",
      additions: 0,
      deletions: 0,
    });
    assert.deepStrictEqual(files[1], {
      path: "new.ts",
      oldPath: "old.ts",
      status: "R",
      group: "staged",
      additions: 0,
      deletions: 0,
    });
    assert.deepStrictEqual(files[2], {
      path: "c.ts",
      status: "A",
      group: "staged",
      additions: 0,
      deletions: 0,
    });
  });
});

suite("buildFileTree", () => {
  const mk = (p: string): ChangedFile => ({
    path: p,
    status: "M",
    group: "unstaged",
    additions: 0,
    deletions: 0,
  });

  test("nests files under folders and sorts folders before files", () => {
    const tree = buildFileTree([mk("z.ts"), mk("src/a.ts"), mk("src/b.ts")]);
    assert.strictEqual(tree.length, 2);
    assert.strictEqual(tree[0].type, "folder");
    if (tree[0].type === "folder") {
      assert.strictEqual(tree[0].name, "src");
      assert.strictEqual(tree[0].children.length, 2);
    }
    assert.strictEqual(tree[1].type, "file");
  });

  test("compresses single-child folder chains", () => {
    const tree = buildFileTree([mk("src/review/x.ts")]);
    assert.strictEqual(tree.length, 1);
    assert.strictEqual(tree[0].type, "folder");
    if (tree[0].type === "folder") {
      assert.strictEqual(tree[0].name, "src/review");
      assert.strictEqual(tree[0].path, "src/review");
      assert.strictEqual(tree[0].children.length, 1);
      assert.strictEqual(tree[0].children[0].type, "file");
    }
  });

  test("filesInEntry collects all files under a folder, including nested subfolders", () => {
    const tree = buildFileTree([mk("src/a.ts"), mk("src/git/b.ts"), mk("src/git/c.ts")]);
    const srcFolder = tree.find((e) => e.type === "folder");
    assert.ok(srcFolder);
    const paths = filesInEntry(srcFolder)
      .map((f) => f.path)
      .sort();
    assert.deepStrictEqual(paths, ["src/a.ts", "src/git/b.ts", "src/git/c.ts"]);
  });
});

suite("renderPlanFeedback", () => {
  test("orders problem before question/comment and includes all kinds", () => {
    const out = renderPlanFeedback([
      { line: 5, quote: "do X", body: "make it Y", kind: "comment" },
      { line: 1, quote: "do Z", body: "must not Z", kind: "problem" },
      { line: 9, quote: "fyi", body: "consider this", kind: "question" },
    ]);
    assert.ok(/feedback/i.test(out));
    assert.ok(out.indexOf("[PROBLEM]") < out.indexOf("[QUESTION]"));
    assert.ok(out.indexOf("[QUESTION]") < out.indexOf("[COMMENT]"));
    assert.ok(out.includes("consider this"));
    assert.ok(out.includes("(1 problem, 1 question, 1 comment)"));
  });
});

suite("renderReviewFeedback", () => {
  const mk = (over: Partial<ReviewComment>): ReviewComment => ({
    id: "x",
    filePath: "src/a.ts",
    side: "modified",
    line: 0,
    kind: "comment",
    body: "fix",
    resolved: false,
    quote: "line",
    anchor: { lineText: "line", contextBefore: [], contextAfter: [], lineHash: "h" },
    ...over,
  });

  test("includes all unresolved kinds, excludes resolved, problems first", () => {
    const out = renderReviewFeedback([
      mk({ kind: "question", body: "a-question" }),
      mk({ resolved: true, body: "resolved-only" }),
      mk({ kind: "problem", body: "real-issue", line: 41 }),
    ]);
    assert.ok(out.includes("real-issue"));
    assert.ok(out.includes("a-question"));
    assert.ok(!out.includes("resolved-only"));
    assert.ok(out.indexOf("[PROBLEM]") < out.indexOf("[QUESTION]"));
    assert.ok(out.includes("src/a.ts:42"));
  });

  test("returns empty when all comments are resolved", () => {
    assert.strictEqual(renderReviewFeedback([mk({ resolved: true })]), "");
  });
});

suite("ReviewGateRegistry", () => {
  test("fulfill resolves the pending awaitDecision", async () => {
    const reg = new ReviewGateRegistry();
    const p = reg.awaitDecision("r1");
    assert.strictEqual(reg.fulfill("r1", { status: "submitted", feedback: "fb" }), true);
    assert.deepStrictEqual(await p, { status: "submitted", feedback: "fb" });
  });

  test("fulfill on unknown id is a no-op", () => {
    const reg = new ReviewGateRegistry();
    assert.strictEqual(reg.fulfill("missing", { status: "cancelled", feedback: "" }), false);
  });

  test("a second awaitDecision for the same id supersedes the first as cancelled", async () => {
    const reg = new ReviewGateRegistry();
    const first = reg.awaitDecision("r1");
    reg.awaitDecision("r1"); // supersede
    assert.deepStrictEqual(await first, { status: "cancelled", feedback: "" });
  });

  test("drain resolves all outstanding gates", async () => {
    const reg = new ReviewGateRegistry();
    const a = reg.awaitDecision("a");
    const b = reg.awaitDecision("b");
    reg.drain({ status: "cancelled", feedback: "" });
    assert.deepStrictEqual(await a, { status: "cancelled", feedback: "" });
    assert.deepStrictEqual(await b, { status: "cancelled", feedback: "" });
  });
});

suite("GateCoordinator (one-at-a-time)", () => {
  const session = (kind: "plan" | "review"): GateSession => ({
    kind,
    approve() {},
    sendFeedback() {},
  });

  test("first acquire is immediate; a second waits until the first releases", async () => {
    const c = new GateCoordinator();
    const relA = await c.acquire(session("plan"));
    assert.strictEqual(c.isActive(), true);
    assert.strictEqual(c.current?.kind, "plan");

    let bAcquired = false;
    const pB = c.acquire(session("review")).then((rel) => {
      bAcquired = true;
      return rel;
    });
    await Promise.resolve();
    assert.strictEqual(
      bAcquired,
      false,
      "second acquire must block while the first holds the slot",
    );
    assert.strictEqual(c.current?.kind, "plan");

    relA();
    const relB = await pB;
    assert.strictEqual(bAcquired, true);
    assert.strictEqual(c.current?.kind, "review");
    relB();
    assert.strictEqual(c.isActive(), false);
  });

  test("abort while queued rejects the waiter and leaves the active slot held", async () => {
    const c = new GateCoordinator();
    const relA = await c.acquire(session("plan"));
    const ac = new AbortController();
    const pB = c.acquire(session("review"), ac.signal);
    ac.abort();
    await assert.rejects(pB);
    assert.strictEqual(
      c.current?.kind,
      "plan",
      "the queued waiter dropping out must not disturb the holder",
    );
    relA();
    assert.strictEqual(c.isActive(), false);
  });

  test("acquire with an already-aborted signal rejects immediately", async () => {
    const c = new GateCoordinator();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(c.acquire(session("plan"), ac.signal));
    assert.strictEqual(c.isActive(), false);
  });

  test("release is idempotent", async () => {
    const c = new GateCoordinator();
    const rel = await c.acquire(session("plan"));
    rel();
    rel();
    assert.strictEqual(c.isActive(), false);
  });
});

suite("isStaleActive (interrupt fallback)", () => {
  const now = 1_000_000_000;
  const old = now - STALE_ACTIVE_MS_FOR_TEST - 1;

  test("active + silent past the window is stale", () => {
    assert.strictEqual(isStaleActive("thinking", old, now), true);
    assert.strictEqual(isStaleActive("toolRunning", old, now), true);
  });

  test("active but recent is not stale", () => {
    assert.strictEqual(isStaleActive("thinking", now - 1000, now), false);
  });

  test("non-active states never go stale (resolved by their own flows)", () => {
    assert.strictEqual(isStaleActive("idle", old, now), false);
    assert.strictEqual(isStaleActive("stopped", old, now), false);
    assert.strictEqual(isStaleActive("awaitingPlanApproval", old, now), false);
    assert.strictEqual(isStaleActive("awaitingPermission", old, now), false);
  });
});
