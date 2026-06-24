import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { activityPath, canonicalize, indexPath, repoKey, stateDir } from "../protocol/paths.js";
import { repoSnapshots } from "../bridge/ActivitySnapshot.js";
import { summarizeActivity } from "../agents/activitySummary.js";
import { parseWorktrees } from "../git/WorktreeService.js";
import { parseNameStatus, type ChangedFile } from "../git/DiffService.js";
import { buildFileTree, filesInEntry } from "../views/fileTree.js";
import { renderPlanFeedback } from "../plan/planFeedback.js";
import { renderReviewFeedback } from "../review/reviewFeedback.js";
import type { ReviewComment } from "../review/reviewTypes.js";
import { ReviewGateRegistry } from "../review/ReviewGateRegistry.js";
import { PlanGateRegistry } from "../plan/PlanGateRegistry.js";
import { GateCoordinator, type GateEntry } from "../gate/GateCoordinator.js";
import {
  AgentSessionService,
  isStaleActive,
  STALE_ACTIVE_MS_FOR_TEST,
} from "../agents/AgentSessionService.js";
import type { HookEventMessage } from "../protocol/types.js";
import { shortSessionId } from "../views/MainTreeProvider.js";
import { isFileEditable, reconcileDiffTarget, stopGateAction } from "../review/ReviewController.js";
import type { ChangesModel } from "../git/DiffService.js";
import type { FileGroup } from "../types.js";

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

suite("GateCoordinator (foreground registry)", () => {
  const makeEntry = (
    id: string,
    kind: "plan" | "review",
    log: string[],
    hasFeedback = false,
  ): GateEntry => ({
    id,
    sessionId: id,
    kind,
    repoRoot: "/repo",
    session: { kind, approve() {}, sendFeedback() {}, hasFeedback: () => hasFeedback },
    foreground: () => {
      log.push(`fg:${id}`);
    },
    background: () => {
      log.push(`bg:${id}`);
    },
  });
  test("first registered gate is foreground; a second stays pending", async () => {
    const c = new GateCoordinator(
      async () => {},
      async () => {},
    );
    const log: string[] = [];
    await c.register(makeEntry("a", "plan", log));
    await c.register(makeEntry("b", "plan", log));
    assert.strictEqual(c.isForeground("a"), true);
    assert.strictEqual(c.isForeground("b"), false);
    assert.strictEqual(c.current?.kind, "plan");
    assert.deepStrictEqual(log, ["fg:a"]);
  });

  test("switchTo backgrounds the current and foregrounds the target, and back again", async () => {
    const c = new GateCoordinator(
      async () => {},
      async () => {},
    );
    const log: string[] = [];
    await c.register(makeEntry("a", "plan", log));
    await c.register(makeEntry("b", "review", log));
    await c.switchTo("b");
    assert.strictEqual(c.isForeground("b"), true);
    assert.deepStrictEqual(log, ["fg:a", "bg:a", "fg:b"]);
    await c.switchTo("a");
    assert.strictEqual(c.isForeground("a"), true);
    assert.deepStrictEqual(log, ["fg:a", "bg:a", "fg:b", "bg:b", "fg:a"]);
  });

  test("unregistering the foreground promotes the most-recent remaining gate", async () => {
    const c = new GateCoordinator(
      async () => {},
      async () => {},
    );
    const log: string[] = [];
    await c.register(makeEntry("a", "plan", log));
    await c.register(makeEntry("b", "plan", log));
    await c.unregister("a");
    assert.strictEqual(c.isForeground("b"), true);
    assert.strictEqual(c.isActive(), true);
  });

  test("current.hasFeedback() reflects the foreground gate (drives which button shows)", async () => {
    const c = new GateCoordinator(
      async () => {},
      async () => {},
    );
    const log: string[] = [];
    await c.register(makeEntry("a", "plan", log, false)); // no comments yet → Approve shows
    assert.strictEqual(c.current?.hasFeedback(), false);
    await c.register(makeEntry("b", "review", log, true)); // pending, not foreground
    assert.strictEqual(c.current?.hasFeedback(), false); // still showing "a"
    await c.switchTo("b"); // switch foreground → its feedback drives the button
    assert.strictEqual(c.current?.hasFeedback(), true);
  });

  test("entryForSession and entriesForRepo", async () => {
    const c = new GateCoordinator(
      async () => {},
      async () => {},
    );
    const log: string[] = [];
    await c.register(makeEntry("a", "plan", log));
    assert.strictEqual(c.entryForSession("a")?.id, "a");
    assert.strictEqual(c.entriesForRepo("/repo").length, 1);
    assert.strictEqual(c.entriesForRepo("/other").length, 0);
  });

  test("bottom panel hides for any foreground gate (plan or review), restores only when none remain", async () => {
    const panel: string[] = [];
    const c = new GateCoordinator(
      async () => {
        panel.push("hide");
      },
      async () => {
        panel.push("show");
      },
    );
    const log: string[] = [];

    await c.register(makeEntry("p", "plan", log)); // plan foreground → hide
    assert.deepStrictEqual(panel, ["hide"]);

    await c.register(makeEntry("r", "review", log)); // pending behind the plan
    await c.switchTo("r"); // plan → review: still a gate foreground, panel stays hidden (no flicker)
    assert.deepStrictEqual(panel, ["hide"], "switching between gates must not re-toggle the panel");

    await c.unregister("r"); // review resolved → promote the plan, still hidden
    assert.deepStrictEqual(panel, ["hide"]);

    await c.unregister("p"); // nothing left → restore
    assert.deepStrictEqual(panel, ["hide", "show"]);
    assert.strictEqual(c.isActive(), false);
  });

  test("a review-only foreground also hides the bottom panel", async () => {
    const panel: string[] = [];
    const c = new GateCoordinator(
      async () => {
        panel.push("hide");
      },
      async () => {
        panel.push("show");
      },
    );
    await c.register(makeEntry("r", "review", []));
    assert.deepStrictEqual(panel, ["hide"]);
    await c.unregister("r");
    assert.deepStrictEqual(panel, ["hide", "show"]);
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

suite("AgentSessionService.markIdleOnDisconnect", () => {
  const ev = (event: string, toolName?: string): HookEventMessage =>
    ({
      t: "hook.event",
      v: 1,
      ts: "t",
      event,
      sessionId: "s1",
      cwd: "/repo",
      repoRoot: "/repo",
      toolName,
    }) as HookEventMessage;

  test("resets a gated session (awaiting plan / thinking) back to idle on disconnect", () => {
    const svc = new AgentSessionService();
    try {
      svc.ingest(ev("SessionStart"));
      svc.ingest(ev("UserPromptSubmit"));
      svc.ingest(ev("PreToolUse", "ExitPlanMode"));
      assert.strictEqual(svc.activityForRepo("/repo").state, "awaitingPlanApproval");

      svc.markIdleOnDisconnect("s1");
      assert.strictEqual(svc.activityForRepo("/repo").state, "idle");

      // A later event still updates the session (it wasn't removed).
      svc.ingest(ev("UserPromptSubmit"));
      assert.strictEqual(svc.activityForRepo("/repo").state, "thinking");
    } finally {
      svc.dispose();
    }
  });

  test("is a no-op for an unknown session", () => {
    const svc = new AgentSessionService();
    try {
      svc.markIdleOnDisconnect("missing"); // must not throw
      assert.strictEqual(svc.activityForRepo("/repo").state, "idle");
    } finally {
      svc.dispose();
    }
  });
});

suite("AgentSessionService.removeSession (agent process died)", () => {
  const ev = (event: string): HookEventMessage =>
    ({
      t: "hook.event",
      v: 1,
      ts: "t",
      event,
      sessionId: "s1",
      cwd: "/repo",
      repoRoot: "/repo",
    }) as HookEventMessage;

  test("removes the session entirely (liveness connection dropped)", () => {
    const svc = new AgentSessionService();
    try {
      svc.ingest(ev("SessionStart"));
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 1);

      svc.removeSession("s1");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 0);

      // A still-alive agent (MCP-only crash) is re-created by its next telemetry event.
      svc.ingest(ev("UserPromptSubmit"));
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 1);
      assert.strictEqual(svc.activityForRepo("/repo").state, "thinking");
    } finally {
      svc.dispose();
    }
  });

  test("is a no-op for an unknown session", () => {
    const svc = new AgentSessionService();
    try {
      svc.removeSession("missing"); // must not throw
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 0);
    } finally {
      svc.dispose();
    }
  });
});

suite("AgentSessionService liveness ref-counting", () => {
  const ev = (event: string): HookEventMessage =>
    ({
      t: "hook.event",
      v: 1,
      ts: "t",
      event,
      sessionId: "s1",
      cwd: "/repo",
      repoRoot: "/repo",
    }) as HookEventMessage;

  test("removes only when the LAST liveness connection detaches", () => {
    const svc = new AgentSessionService();
    try {
      svc.ingest(ev("SessionStart"));
      svc.attachSession("s1");
      svc.attachSession("s1"); // e.g. MCP server + an emulator on the same session
      svc.detachSession("s1");
      assert.strictEqual(
        svc.sessionsForRepo("/repo").length,
        1,
        "alive while one connection remains",
      );
      svc.detachSession("s1");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 0, "removed when the last drops");
    } finally {
      svc.dispose();
    }
  });

  test("a single attach/detach removes the session", () => {
    const svc = new AgentSessionService();
    try {
      svc.ingest(ev("SessionStart"));
      svc.attachSession("s1");
      svc.detachSession("s1");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 0);
    } finally {
      svc.dispose();
    }
  });
});

suite("AgentSessionService attention (onDidFinish / needsAttention)", () => {
  const ev = (event: string, toolName?: string): HookEventMessage =>
    ({
      t: "hook.event",
      v: 1,
      ts: "t",
      event,
      sessionId: "s1",
      cwd: "/repo",
      repoRoot: "/repo",
      toolName,
    }) as HookEventMessage;

  const session = (svc: AgentSessionService) => svc.sessionsForRepo("/repo")[0];
  // Window not focused, so needs-you transitions DO mark/ping (the default reads the real window).
  const mkSvc = () => new AgentSessionService(() => false);

  test("fires once on entering a needs-you state and sets needsAttention", () => {
    const svc = mkSvc();
    const fired: string[] = [];
    svc.onDidFinish((s) => fired.push(s.state));
    try {
      svc.ingest(ev("SessionStart"));
      svc.ingest(ev("UserPromptSubmit"));
      assert.deepStrictEqual(fired, [], "busy states don't notify");
      svc.ingest(ev("Stop"));
      assert.deepStrictEqual(fired, ["stopped"]);
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("does NOT re-fire while staying within needs-you states", () => {
    const svc = mkSvc();
    const fired: string[] = [];
    svc.onDidFinish((s) => fired.push(s.state));
    try {
      svc.ingest(ev("SessionStart"));
      svc.ingest(ev("Stop")); // stopped (needs-you) — fires
      svc.ingest(ev("PermissionRequest")); // awaitingPermission (still needs-you) — no re-fire
      assert.deepStrictEqual(fired, ["stopped"]);
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("clears on going busy/idle and re-arms on the next needs-you transition", () => {
    const svc = mkSvc();
    const fired: string[] = [];
    svc.onDidFinish((s) => fired.push(s.state));
    try {
      svc.ingest(ev("SessionStart"));
      svc.ingest(ev("Stop"));
      assert.strictEqual(session(svc).needsAttention, true);
      svc.ingest(ev("UserPromptSubmit")); // a new turn — clears
      assert.strictEqual(session(svc).needsAttention, false);
      svc.ingest(ev("PreToolUse", "ExitPlanMode")); // awaitingPlanApproval — re-arms + re-fires
      assert.deepStrictEqual(fired, ["stopped", "awaitingPlanApproval"]);
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("does NOT mark or fire when this window is focused", () => {
    const svc = new AgentSessionService(() => true); // user is already looking at the editor
    const fired: string[] = [];
    svc.onDidFinish((s) => fired.push(s.state));
    try {
      svc.ingest(ev("SessionStart"));
      svc.ingest(ev("Stop"));
      assert.deepStrictEqual(fired, [], "no ping while focused");
      assert.strictEqual(session(svc).needsAttention, false, "no bell while focused");
    } finally {
      svc.dispose();
    }
  });

  test("clearAttention drops the marker without a state change", () => {
    const svc = mkSvc();
    try {
      svc.ingest(ev("SessionStart"));
      svc.ingest(ev("Stop"));
      assert.strictEqual(session(svc).needsAttention, true);
      svc.clearAttention("s1");
      assert.strictEqual(session(svc).needsAttention, false);
      assert.strictEqual(session(svc).state, "stopped", "state is untouched");
    } finally {
      svc.dispose();
    }
  });

  test("markIdleOnDisconnect also clears the marker", () => {
    const svc = mkSvc();
    try {
      svc.ingest(ev("SessionStart"));
      svc.ingest(ev("PreToolUse", "ExitPlanMode"));
      assert.strictEqual(session(svc).needsAttention, true);
      svc.markIdleOnDisconnect("s1");
      assert.strictEqual(session(svc).needsAttention, false);
      assert.strictEqual(session(svc).state, "idle");
    } finally {
      svc.dispose();
    }
  });
});

suite("summarizeActivity", () => {
  test("needsAttention wins over state", () => {
    const s = summarizeActivity(
      { sessionCount: 1, subagentCount: 0, state: "thinking", needsAttention: true },
      true,
    );
    assert.match(s, /needs you/);
  });
  test("no sessions → idle", () => {
    assert.strictEqual(
      summarizeActivity({
        sessionCount: 0,
        subagentCount: 0,
        state: "idle",
        needsAttention: false,
      }),
      "idle",
    );
  });
  test("renders the busy state with a codicon and agent count", () => {
    const s = summarizeActivity({
      sessionCount: 2,
      subagentCount: 1,
      state: "thinking",
      needsAttention: false,
    });
    assert.match(s, /thinking/);
    assert.match(s, /2 agents/);
    assert.match(s, /1 sub/);
  });
});

suite("repoSnapshots (cross-repo switcher activity)", () => {
  // Point the state dir at a temp location so we read a synthetic index + activity files.
  let prevXdg: string | undefined;
  let dir: string;

  const writeIndex = (entries: object[]): void => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify({ version: 1, entries }));
  };
  const writeActivity = (root: string, body: object): void => {
    fs.mkdirSync(path.dirname(activityPath(root)), { recursive: true });
    fs.writeFileSync(activityPath(root), JSON.stringify(body));
  };

  setup(() => {
    prevXdg = process.env.XDG_STATE_HOME;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-activity-"));
    process.env.XDG_STATE_HOME = dir;
  });
  teardown(() => {
    if (prevXdg === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = prevXdg;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("open repo with a live window reports its published activity", () => {
    const root = "/work/open-repo";
    writeIndex([
      {
        repoRoot: root,
        key: repoKey(root),
        socketPath: "x.sock",
        pid: process.pid, // this test process is alive
        windowId: "w1",
        startedAt: "t",
        protocolVersion: 1,
      },
    ]);
    writeActivity(root, {
      version: 1,
      repoRoot: root,
      repoKey: repoKey(root),
      pid: process.pid,
      updatedAt: "t",
      activity: { sessionCount: 1, subagentCount: 0, state: "thinking" },
      needsAttention: true,
    });

    const snap = repoSnapshots([root]).get(root);
    assert.ok(snap);
    assert.strictEqual(snap.open, true);
    assert.strictEqual(snap.needsAttention, true);
    assert.strictEqual(snap.activity?.state, "thinking");
  });

  test("a repo with no index entry reports closed (no window)", () => {
    writeIndex([]);
    const root = "/work/closed-repo";
    const snap = repoSnapshots([root]).get(root);
    assert.ok(snap);
    assert.strictEqual(snap.open, false);
    assert.strictEqual(snap.activity, undefined);
  });

  test("a dead pid in the index does not count as open", () => {
    const root = "/work/dead-repo";
    writeIndex([
      {
        repoRoot: root,
        key: repoKey(root),
        socketPath: "x.sock",
        pid: 2147483646, // not a live pid
        windowId: "w1",
        startedAt: "t",
        protocolVersion: 1,
      },
    ]);
    const snap = repoSnapshots([root]).get(root);
    assert.strictEqual(snap?.open, false);
  });
});

suite("reconcileDiffTarget (open-diff re-point after stage/unstage/discard)", () => {
  test("staging an unstaged file re-points it to staged", () => {
    assert.strictEqual(reconcileDiffTarget("unstaged", ["staged"], "staged"), "staged");
  });

  test("unstaging a staged file re-points it to unstaged", () => {
    assert.strictEqual(reconcileDiffTarget("staged", ["unstaged"], "unstaged"), "unstaged");
  });

  test("discarding the only change closes the tab", () => {
    assert.strictEqual(reconcileDiffTarget("unstaged", []), "close");
  });

  test("a partially-staged file still present at its old level is kept", () => {
    assert.strictEqual(reconcileDiffTarget("unstaged", ["staged", "unstaged"], "staged"), "keep");
  });

  test("falls back to the first candidate when the preferred group isn't present", () => {
    assert.strictEqual(reconcileDiffTarget("staged", ["committed"], "unstaged"), "committed");
  });
});

suite("isFileEditable (structural, session-independent)", () => {
  const f = (path: string, group: FileGroup, status = "M"): ChangedFile =>
    ({ path, group, status, additions: 1, deletions: 0 }) as ChangedFile;
  const model = (over: Partial<ChangesModel>): ChangesModel => ({
    staged: [],
    unstaged: [],
    committed: [],
    compareLabel: "HEAD",
    compareRef: null,
    ...over,
  });

  test("an unstaged file is editable", () => {
    const file = f("a.ts", "unstaged");
    assert.strictEqual(isFileEditable(file, model({ unstaged: [file] })), true);
  });

  test("a staged file with no unstaged change is editable", () => {
    const file = f("a.ts", "staged");
    assert.strictEqual(isFileEditable(file, model({ staged: [file] })), true);
  });

  test("a staged file that also has unstaged changes is locked", () => {
    const staged = f("a.ts", "staged");
    assert.strictEqual(
      isFileEditable(staged, model({ staged: [staged], unstaged: [f("a.ts", "unstaged")] })),
      false,
    );
  });

  test("a committed file with a lower-level change is locked", () => {
    const committed = f("a.ts", "committed");
    assert.strictEqual(
      isFileEditable(committed, model({ committed: [committed], staged: [f("a.ts", "staged")] })),
      false,
    );
  });

  test("a deleted file is never editable", () => {
    const file = f("a.ts", "unstaged", "D");
    assert.strictEqual(isFileEditable(file, model({ unstaged: [file] })), false);
  });
});

suite("stopGateAction (turn-end review gate)", () => {
  const base = {
    hasPendingFeedback: false,
    reviewActive: false,
    reviewIsDeferred: false,
    changedThisTurn: false,
    hasUncommittedChanges: false,
    reviewBusy: false,
  };
  test("allows immediately when the turn changed nothing", () => {
    assert.strictEqual(stopGateAction(base), "allow");
  });
  test("opens a review when the turn touched files", () => {
    assert.strictEqual(stopGateAction({ ...base, changedThisTurn: true }), "review");
  });
  test("opens a review when there are uncommitted changes (backup signal)", () => {
    assert.strictEqual(stopGateAction({ ...base, hasUncommittedChanges: true }), "review");
  });
  test("delivers already-submitted feedback", () => {
    assert.strictEqual(
      stopGateAction({ ...base, hasPendingFeedback: true, changedThisTurn: true }),
      "deliver-pending",
    );
  });
  test("waits on an in-progress deferred review", () => {
    assert.strictEqual(
      stopGateAction({ ...base, reviewActive: true, reviewIsDeferred: true }),
      "review",
    );
  });
  test("stays out of the way of a blocking /tui-review session", () => {
    assert.strictEqual(
      stopGateAction({
        ...base,
        reviewActive: true,
        reviewIsDeferred: false,
        changedThisTurn: true,
      }),
      "allow",
    );
  });
  test("does not open a second review while the slot is busy", () => {
    assert.strictEqual(
      stopGateAction({ ...base, changedThisTurn: true, reviewBusy: true }),
      "allow",
    );
  });
});

suite("AgentSessionService.didChangeThisTurn (Stop-gate signal)", () => {
  const ev = (event: string, toolName?: string): HookEventMessage =>
    ({
      t: "hook.event",
      v: 1,
      ts: "t",
      event,
      sessionId: "s1",
      cwd: "/repo",
      repoRoot: "/repo",
      toolName,
    }) as HookEventMessage;
  const mk = () => new AgentSessionService(() => false);

  test("an edit-class tool marks the turn as having touched files", () => {
    const svc = mk();
    try {
      svc.ingest(ev("UserPromptSubmit"));
      assert.strictEqual(svc.didChangeThisTurn("s1"), false);
      svc.ingest(ev("PreToolUse", "Edit"));
      svc.ingest(ev("PostToolUse", "Edit"));
      assert.strictEqual(svc.didChangeThisTurn("s1"), true);
    } finally {
      svc.dispose();
    }
  });

  test("a read-only tool does not mark the turn", () => {
    const svc = mk();
    try {
      svc.ingest(ev("UserPromptSubmit"));
      svc.ingest(ev("PostToolUse", "Read"));
      assert.strictEqual(svc.didChangeThisTurn("s1"), false);
    } finally {
      svc.dispose();
    }
  });

  test("a new turn (UserPromptSubmit) resets the flag", () => {
    const svc = mk();
    try {
      svc.ingest(ev("PostToolUse", "Write"));
      assert.strictEqual(svc.didChangeThisTurn("s1"), true);
      svc.ingest(ev("UserPromptSubmit"));
      assert.strictEqual(svc.didChangeThisTurn("s1"), false);
    } finally {
      svc.dispose();
    }
  });
});

suite("PlanGateRegistry (plan auto-mode forwarding)", () => {
  test("carries nextMode from fulfill through to the awaited decision", async () => {
    const reg = new PlanGateRegistry();
    const key = PlanGateRegistry.key("s1", "p1");
    const decision = reg.awaitDecision(key);
    reg.fulfill(key, { decision: "allow", nextMode: "auto" });
    assert.deepStrictEqual(await decision, { decision: "allow", nextMode: "auto" });
  });

  test("deny carries no nextMode", async () => {
    const reg = new PlanGateRegistry();
    const key = PlanGateRegistry.key("s1", "p1");
    const decision = reg.awaitDecision(key);
    reg.fulfill(key, { decision: "deny", reason: "fix it" });
    const result = await decision;
    assert.strictEqual(result.decision, "deny");
    assert.strictEqual(result.nextMode, undefined);
  });
});

suite("shortSessionId (agent label)", () => {
  test("takes the first 8 chars of the session UUID", () => {
    assert.strictEqual(shortSessionId("a1b2c3d4-e5f6-7890-abcd-ef0123456789"), "a1b2c3d4");
  });

  test("distinguishes two sessions sharing a repo", () => {
    assert.notStrictEqual(shortSessionId("11111111-aaaa"), shortSessionId("22222222-bbbb"));
  });

  test("returns short ids unchanged", () => {
    assert.strictEqual(shortSessionId("abc"), "abc");
  });
});
