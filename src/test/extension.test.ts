import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { activityPath, canonicalize, indexPath, repoKey, stateDir } from "../protocol/paths.js";
import { pickCurrentRepo, type RepoInfo } from "../git/RepoService.js";
import { relatedWorkspaceFolder } from "../git/WorkspaceRootCatalog.js";
import { repoSnapshots } from "../bridge/ActivitySnapshot.js";
import { ClaudeCodeStrategy } from "../harness/ClaudeCodeStrategy.js";
import { AgentServiceLocator } from "../harness/AgentServiceLocator.js";
import type { AgentStrategy } from "../harness/AgentStrategy.js";
import type { AppEvent, AppEventKind } from "../harness/appEvent.js";
import { summarizeActivity } from "../agents/activitySummary.js";
import { parseWorktrees } from "../git/WorktreeService.js";
import { branchFromRevParse, gitToplevel } from "../git/gitCli.js";
import { buildSwitcherSections } from "../status/switcherRows.js";
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
  shouldNotify,
  stateForNotification,
  STALE_ACTIVE_MS_FOR_TEST,
} from "../agents/AgentSessionService.js";
import type { AnyMessage, Harness, HookEventMessage } from "../protocol/types.js";
import type {
  ClaudeCodeBackgroundTaskSummary,
  ClaudeCodeHookEvent,
  ClaudeCodeSessionCronSummary,
} from "../harness/ClaudeCodeStrategy.js";
import { resolvePlanApproveMode } from "../plan/PlanReviewController.js";
import type { AgentSession } from "../agents/AgentSession.js";
import { NotificationService } from "../notify/NotificationService.js";
import { createInboundEventLog } from "../bridge/SocketServer.js";
import {
  agentLabel,
  changedFileCount,
  commandSession,
  computeViewBadge,
  repositoryBranchLabel,
  shortSessionId,
} from "../views/MainTreeProvider.js";
import { pickAuthorName } from "../comments/author.js";
import {
  isFileEditable,
  markOpenDiffEdited,
  reconcileDiffTarget,
  selectCommentFile,
  shouldOpenStandaloneCommentTarget,
  shouldOpenTurnEndReview,
} from "../review/ReviewController.js";
import { relocateReviewAnchor } from "../review/commentAnchors.js";
import { compareToEqual, currentFileCompareKind } from "../review/reviewSelectors.js";
import { getAutoRevealSetting } from "../util/editorSettings.js";
import type { ChangesModel } from "../git/DiffService.js";
import type { FileGroup } from "../types.js";

/** Minimal valid `background_tasks`/`session_crons` entries for tests — only the counts matter, but
 *  the types require all their documented fields. */
function mkBackgroundTask(id: string): ClaudeCodeBackgroundTaskSummary {
  return { id, type: "bash", status: "running", description: "test task" };
}
function mkSessionCron(id: string): ClaudeCodeSessionCronSummary {
  return { id, schedule: "*/5 * * * *", recurring: true, prompt: "check in" };
}

/** Builds a HookEventMessage carrying a raw hook event, with sensible test defaults — the wire
 *  protocol forwards Claude Code's raw hook payload (snake_case) rather than pre-extracted fields. */
function mkHookEvent(
  hookEventName: string,
  overrides: Partial<ClaudeCodeHookEvent> & { sessionId?: string; repoRoot?: string } = {},
): HookEventMessage {
  const { sessionId = "s1", repoRoot = "/repo", ...rest } = overrides;
  return {
    t: "hook.event",
    v: "1",
    ts: "t",
    harness: "claudecode",
    repoRoot,
    event: { hook_event_name: hookEventName, session_id: sessionId, ...rest },
  } as HookEventMessage;
}

// Typed as the interface so ingestWire dispatches through the union-accepting signature exactly like
// the production boundary (the concrete method narrows to ClaudeCodeHookEvent — see the bivariance note).
const claudeStrategy: AgentStrategy = new ClaudeCodeStrategy();
// The service needs a locator to stamp each session's supportsLiveness; the production locator knows
// every harness, so one instance serves every suite that ingests Claude (or other-harness) events.
const claudeLocator = new AgentServiceLocator();

/** Test bridge: map a raw wire HookEventMessage through the Claude strategy, then ingest — so the
 *  fixtures keep exercising the FULL boundary path (strategy.toAppEvent + AgentSessionService.ingest)
 *  the extension uses, now that ingest takes an already-mapped AppEvent. */
function ingestWire(svc: AgentSessionService, msg: HookEventMessage): void {
  const event = claudeStrategy.toAppEvent(msg.event);
  if (event) {
    svc.ingest(event, msg.repoRoot);
  }
}

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
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-key-"));
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

suite("command manifest", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
  ) as {
    contributes: {
      commands: Array<{ command: string; title: string }>;
      menus: { commandPalette: Array<{ command: string; when?: string }> };
    };
  };

  test("every command exposed in the Command Palette is namespaced as Paireto", () => {
    const paletteHidden = new Set(
      manifest.contributes.menus.commandPalette
        .filter(({ when }) => when === "false")
        .map(({ command }) => command),
    );
    const unprefixed = manifest.contributes.commands.filter(
      ({ command, title }) => !paletteHidden.has(command) && !title.startsWith("Paireto: "),
    );
    assert.deepStrictEqual(
      unprefixed,
      [],
      `unprefixed palette commands: ${unprefixed.map(({ command }) => command).join(", ")}`,
    );
  });

  test("commands shown only inside local comment/tree context keep concise titles", () => {
    const localCommands = new Set([
      "paireto.comment.edit",
      "paireto.comment.save",
      "paireto.comment.delete",
      "paireto.plan.addComment",
      "paireto.plan.addQuestion",
      "paireto.plan.addProblem",
      "paireto.review.openDiff",
      "paireto.review.openFile",
      "paireto.review.stage",
      "paireto.review.unstage",
      "paireto.review.discard",
      "paireto.review.addComment",
      "paireto.review.addQuestion",
      "paireto.review.addProblem",
      "paireto.review.revealComment",
      "paireto.review.deleteComment",
      "paireto.agent.switch",
      "paireto.agent.hide",
      "paireto.agent.show",
    ]);
    const incorrectlyPrefixed = manifest.contributes.commands.filter(
      ({ command, title }) => localCommands.has(command) && title.startsWith("Paireto: "),
    );
    assert.deepStrictEqual(incorrectlyPrefixed, []);
  });

  test("parent editor actions remain namespaced", () => {
    const parentCommands = new Set([
      "paireto.gate.approve",
      "paireto.gate.sendFeedback",
      "paireto.review.pickDiffCompareTo",
    ]);
    const unprefixed = manifest.contributes.commands.filter(
      ({ command, title }) => parentCommands.has(command) && !title.startsWith("Paireto: "),
    );
    assert.deepStrictEqual(unprefixed, []);
  });

  test("comment gutter actions use a namespaced controller label", () => {
    const planSource = fs.readFileSync(
      path.join(__dirname, "../../src/plan/PlanReviewController.ts"),
      "utf8",
    );
    const reviewSource = fs.readFileSync(
      path.join(__dirname, "../../src/review/ReviewController.ts"),
      "utf8",
    );
    assert.match(planSource, /new CommentSession\("paireto\.plan", "Paireto: Add Comment"/);
    assert.match(reviewSource, /"paireto\.review",\s*"Paireto: Add Comment"/);
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

suite("plugin hooks.json is observer-safe", () => {
  // WorktreeCreate is a DELEGATION hook: registering it replaces Claude Code's default worktree
  // creation, and the hook must create the worktree and echo its path — a passthrough observer
  // breaks every worktree operation ("hook succeeded but returned no worktree path"). There is no
  // observer mode, so the plugin must never register it (WorktreeRemove goes with it: without the
  // create event the worktree cache can't stay coherent, so the switcher fetches fresh instead).
  test("never registers the Worktree delegation hooks", () => {
    const hooksJson = path.resolve(__dirname, "../../plugins/claude-code/hooks/hooks.json");
    const config = JSON.parse(fs.readFileSync(hooksJson, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    assert.strictEqual(config.hooks.WorktreeCreate, undefined);
    assert.strictEqual(config.hooks.WorktreeRemove, undefined);
  });
});

suite("branchFromRevParse", () => {
  test("trims a branch name", () => {
    assert.strictEqual(branchFromRevParse("main\n"), "main");
  });
  test("empty output -> undefined", () => {
    assert.strictEqual(branchFromRevParse(""), undefined);
  });
  test("detached HEAD -> undefined", () => {
    assert.strictEqual(branchFromRevParse("HEAD\n"), undefined);
  });
});

// Guards the core fix for worktree/root-repo bridge socket cross-talk: the extension must bind a
// worktree window's socket to the worktree's OWN toplevel, never its main repo's — mirroring
// plugins/claude-code/scripts/bridge.js's gitToplevel exactly, against a real repo + worktree.
suite("gitToplevel (real git CLI, worktree fixture)", () => {
  let base: string;
  let mainRepo: string;
  let worktree: string;

  suiteSetup(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-toplevel-"));
    mainRepo = path.join(base, "main");
    fs.mkdirSync(mainRepo);
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: mainRepo });
    };
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    fs.writeFileSync(path.join(mainRepo, "a.txt"), "a");
    git(["add", "a.txt"]);
    git(["commit", "-q", "-m", "init"]);
    worktree = path.join(base, "worktree");
    git(["worktree", "add", "-q", worktree, "-b", "feature"]);
  });

  suiteTeardown(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("resolves the main repo's own toplevel", async () => {
    assert.strictEqual(await gitToplevel(mainRepo), fs.realpathSync(mainRepo));
  });

  test("resolves a worktree's own toplevel, never the main repo's", async () => {
    const resolved = await gitToplevel(worktree);
    assert.strictEqual(resolved, fs.realpathSync(worktree));
    assert.notStrictEqual(resolved, await gitToplevel(mainRepo));
  });

  test("resolves undefined for a directory outside any git repo", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-nongit-"));
    try {
      assert.strictEqual(await gitToplevel(outside), undefined);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

suite("buildSwitcherSections", () => {
  test("worktree also present in recents shows once (under Worktrees)", () => {
    const sections = buildSwitcherSections(
      undefined,
      [{ fsPath: "/repo/wt", canonical: "/repo/wt", branch: "feature" }],
      [{ fsPath: "/repo/wt", canonical: "/repo/wt", branch: "feature" }],
    );
    assert.strictEqual(sections.worktrees.length, 1);
    assert.strictEqual(sections.recents.length, 0);
    assert.strictEqual(sections.worktrees[0].fsPath, "/repo/wt");
  });

  test("recent equal to current by canonical (different raw spelling) is excluded", () => {
    const sections = buildSwitcherSections(
      { fsPath: "/var/repo", canonical: "/private/var/repo", branch: "main" },
      [],
      [{ fsPath: "/private/var/repo", canonical: "/private/var/repo", branch: "main" }],
    );
    assert.ok(sections.current);
    assert.strictEqual(sections.recents.length, 0);
  });

  test("current label is branch when known, basename fallback otherwise", () => {
    const withBranch = buildSwitcherSections(
      { fsPath: "/x/repo", canonical: "/x/repo", branch: "develop" },
      [],
      [],
    );
    assert.strictEqual(withBranch.current?.label, "develop");
    const noBranch = buildSwitcherSections({ fsPath: "/x/repo", canonical: "/x/repo" }, [], []);
    assert.strictEqual(noBranch.current?.label, "repo");
  });

  test("recent with branch -> branch label + basename description", () => {
    const sections = buildSwitcherSections(
      undefined,
      [],
      [{ fsPath: "/x/my-repo", canonical: "/x/my-repo", branch: "main" }],
    );
    assert.strictEqual(sections.recents[0].label, "main");
    assert.strictEqual(sections.recents[0].description, "my-repo");
    assert.strictEqual(sections.recents[0].detail, "/x/my-repo");
  });

  test("recent without branch -> basename label, no description", () => {
    const sections = buildSwitcherSections(
      undefined,
      [],
      [{ fsPath: "/x/my-repo", canonical: "/x/my-repo" }],
    );
    assert.strictEqual(sections.recents[0].label, "my-repo");
    assert.strictEqual(sections.recents[0].description, undefined);
  });

  test("detached worktree -> (detached) label", () => {
    const sections = buildSwitcherSections(
      undefined,
      [{ fsPath: "/x/wt", canonical: "/x/wt", detached: true }],
      [],
    );
    assert.strictEqual(sections.worktrees[0].label, "(detached)");
  });

  test("locked worktree keeps the locked annotation", () => {
    const sections = buildSwitcherSections(
      undefined,
      [{ fsPath: "/x/wt", canonical: "/x/wt", branch: "feature", locked: true }],
      [],
    );
    assert.ok(sections.worktrees[0].description?.includes("locked"));
  });

  test("two candidates both on main stay distinguishable via description", () => {
    const sections = buildSwitcherSections(
      { fsPath: "/x/repo-a", canonical: "/x/repo-a", branch: "main" },
      [],
      [{ fsPath: "/y/repo-b", canonical: "/y/repo-b", branch: "main" }],
    );
    assert.strictEqual(sections.current?.label, "main");
    assert.strictEqual(sections.recents[0].label, "main");
    assert.notStrictEqual(sections.current?.description, sections.recents[0].description);
    assert.strictEqual(sections.current?.description, "repo-a");
    assert.strictEqual(sections.recents[0].description, "repo-b");
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
    repoRoot: "/repo",
    filePath: "src/a.ts",
    side: "modified",
    line: 0,
    kind: "comment",
    body: "fix",
    quote: "line",
    anchor: { lineText: "line", contextBefore: [], contextAfter: [], lineHash: "h" },
    ...over,
  });

  test("includes all kinds, problems first", () => {
    const out = renderReviewFeedback([
      mk({ kind: "question", body: "a-question" }),
      mk({ kind: "problem", body: "real-issue", line: 41 }),
    ]);
    assert.ok(out.includes("real-issue"));
    assert.ok(out.includes("a-question"));
    assert.ok(out.indexOf("[PROBLEM]") < out.indexOf("[QUESTION]"));
    assert.ok(out.includes("src/a.ts:42"));
  });

  test("returns empty when there are no comments", () => {
    assert.strictEqual(renderReviewFeedback([]), "");
  });

  test("qualifies paths by absolute repo root in a multi-repository review", () => {
    const out = renderReviewFeedback(
      [
        mk({ repoRoot: "/workspace/api", filePath: "src/a.ts", body: "api feedback" }),
        mk({ repoRoot: "/workspace/web", filePath: "src/a.ts", body: "web feedback" }),
      ],
      true,
    );
    assert.ok(out.includes("/workspace/api/src/a.ts:1"));
    assert.ok(out.includes("/workspace/web/src/a.ts:1"));
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
    mkHookEvent(event, { tool_name: toolName });

  test("resets a gated session (awaiting plan / thinking) back to idle on disconnect", () => {
    const svc = new AgentSessionService(claudeLocator);
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit"));
      ingestWire(svc, ev("PreToolUse", "ExitPlanMode"));
      assert.strictEqual(svc.activityForRepo("/repo").state, "awaitingPlanApproval");

      svc.markIdleOnDisconnect("s1");
      assert.strictEqual(svc.activityForRepo("/repo").state, "idle");

      // A later event still updates the session (it wasn't removed).
      ingestWire(svc, ev("UserPromptSubmit"));
      assert.strictEqual(svc.activityForRepo("/repo").state, "thinking");
    } finally {
      svc.dispose();
    }
  });

  test("is a no-op for an unknown session", () => {
    const svc = new AgentSessionService(claudeLocator);
    try {
      svc.markIdleOnDisconnect("missing"); // must not throw
      assert.strictEqual(svc.activityForRepo("/repo").state, "idle");
    } finally {
      svc.dispose();
    }
  });
});

suite("AgentSessionService.removeSession (agent process died)", () => {
  const ev = (event: string): HookEventMessage => mkHookEvent(event);

  test("removes the session entirely (liveness connection dropped)", () => {
    const svc = new AgentSessionService(claudeLocator);
    try {
      ingestWire(svc, ev("SessionStart"));
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 1);

      svc.removeSession("s1");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 0);

      // A still-alive agent (MCP-only crash) is re-created by its next telemetry event.
      ingestWire(svc, ev("UserPromptSubmit"));
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 1);
      assert.strictEqual(svc.activityForRepo("/repo").state, "thinking");
    } finally {
      svc.dispose();
    }
  });

  test("is a no-op for an unknown session", () => {
    const svc = new AgentSessionService(claudeLocator);
    try {
      svc.removeSession("missing"); // must not throw
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 0);
    } finally {
      svc.dispose();
    }
  });
});

suite("AgentSessionService liveness ref-counting", () => {
  const ev = (event: string): HookEventMessage => mkHookEvent(event);

  test("removes only when the LAST liveness connection detaches", () => {
    const svc = new AgentSessionService(claudeLocator);
    try {
      ingestWire(svc, ev("SessionStart"));
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
    const svc = new AgentSessionService(claudeLocator);
    try {
      ingestWire(svc, ev("SessionStart"));
      svc.attachSession("s1");
      svc.detachSession("s1");
      assert.strictEqual(svc.sessionsForRepo("/repo").length, 0);
    } finally {
      svc.dispose();
    }
  });
});

suite("notifyReason (the notify decision + its reason)", () => {
  test("returns a reason on the edge into each needs-you state", () => {
    assert.strictEqual(shouldNotify("stopped", "thinking"), "finished its turn (Stop)");
    assert.strictEqual(
      shouldNotify("awaitingPermission", "toolRunning"),
      "awaiting your permission",
    );
    assert.strictEqual(shouldNotify("awaitingPlanApproval", "thinking"), "awaiting plan approval");
    assert.strictEqual(shouldNotify("awaitingInput", "thinking"), "waiting for your input");
  });

  test("no reason when staying in (not entering) a needs-you state", () => {
    assert.strictEqual(shouldNotify("stopped", "stopped"), undefined);
    assert.strictEqual(shouldNotify("awaitingInput", "awaitingPermission"), undefined);
  });

  test("no reason for a busy/idle transition", () => {
    assert.strictEqual(shouldNotify("thinking", "idle"), undefined);
  });
});

suite("stateForNotification (normalized Notification kinds map onto the state machine)", () => {
  test("user-wanting kinds map to their needs-you state", () => {
    assert.strictEqual(stateForNotification("permissionPrompt"), "awaitingPermission");
    assert.strictEqual(stateForNotification("idlePrompt"), "stopped");
    assert.strictEqual(stateForNotification("inputNeeded"), "awaitingInput");
  });

  test("a missing kind (older CLI) still reads as an input request", () => {
    assert.strictEqual(stateForNotification(undefined), "awaitingInput");
  });

  test("informational kind maps to nothing (no state change, no ping)", () => {
    assert.strictEqual(stateForNotification("informational"), undefined);
  });
});

suite("ClaudeCodeStrategy.toAppEvent (claudecode harness mapping)", () => {
  const raw = (overrides: Partial<ClaudeCodeHookEvent> = {}): ClaudeCodeHookEvent =>
    ({ hook_event_name: "PreToolUse", session_id: "s1", ...overrides }) as ClaudeCodeHookEvent;
  // The mapper drops unmappable events (undefined); every fixture below maps to a real AppEvent, so
  // assert that up front and hand the non-null event to the case.
  const map = (overrides: Partial<ClaudeCodeHookEvent> = {}): AppEvent => {
    const event = claudeStrategy.toAppEvent(raw(overrides));
    assert.ok(event, "expected a mapped AppEvent");
    return event;
  };

  test("maps every ClaudeCodeHookEventName to its normalized kind", () => {
    const cases: Array<[string, string]> = [
      ["SessionStart", "sessionStart"],
      ["SessionEnd", "sessionEnd"],
      ["UserPromptSubmit", "userPromptSubmit"],
      ["PreToolUse", "preToolUse"],
      ["PostToolUse", "postToolUse"],
      ["Stop", "stop"],
      ["Notification", "notification"],
      ["PermissionRequest", "permissionRequest"],
      ["CwdChanged", "cwdChanged"],
      ["FileChanged", "fileChanged"],
      ["SubagentStart", "subagentStart"],
      ["SubagentStop", "subagentStop"],
    ];
    for (const [hookEventName, kind] of cases) {
      assert.strictEqual(map({ hook_event_name: hookEventName as never }).kind, kind);
    }
  });

  test("stamps the harness on every event", () => {
    assert.strictEqual(map().harness, "claudecode");
  });

  test("classifies PreToolUse(ExitPlanMode) as a planProposal, plain PreToolUse otherwise", () => {
    assert.strictEqual(map({ tool_name: "ExitPlanMode" }).kind, "planProposal");
    assert.strictEqual(map({ tool_name: "Bash" }).kind, "preToolUse");
    assert.strictEqual(map().kind, "preToolUse");
  });

  test("flags edit-class tools with isEditTool (false for a read-only tool)", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      assert.strictEqual(map({ tool_name: tool }).isEditTool, true, tool);
    }
    assert.strictEqual(map({ tool_name: "Read" }).isEditTool, false);
    assert.strictEqual(map().isEditTool, false);
  });

  test("returns undefined for an unrecognized hook_event_name (future-proofing, not a crash)", () => {
    assert.strictEqual(
      claudeStrategy.toAppEvent(raw({ hook_event_name: "Bogus" as never })),
      undefined,
    );
  });

  test("carries sessionId, agentId, and toolName through", () => {
    const event = map({ session_id: "abc", agent_id: "sub-1", tool_name: "Edit" });
    assert.strictEqual(event.sessionId, "abc");
    assert.strictEqual(event.agentId, "sub-1");
    assert.strictEqual(event.toolName, "Edit");
  });

  test("extracts the plan markdown from tool_input.plan", () => {
    const event = map({
      hook_event_name: "PermissionRequest",
      tool_input: { plan: "1. Do the thing" },
    });
    assert.strictEqual(event.planText, "1. Do the thing");
  });

  test("plan text is undefined when tool_input has no plan field", () => {
    assert.strictEqual(map({ tool_input: {} }).planText, undefined);
    assert.strictEqual(map().planText, undefined);
  });

  test("collapses notification_type onto the normalized notification-kind set", () => {
    const kindOf = (notificationType: string | undefined) =>
      map({ hook_event_name: "Notification", notification_type: notificationType as never })
        .notificationKind;
    assert.strictEqual(kindOf("permission_prompt"), "permissionPrompt");
    assert.strictEqual(kindOf("idle_prompt"), "idlePrompt");
    assert.strictEqual(kindOf("elicitation_dialog"), "inputNeeded");
    assert.strictEqual(kindOf("agent_needs_input"), "inputNeeded");
    assert.strictEqual(kindOf(undefined), "inputNeeded");
    assert.strictEqual(kindOf("auth_success"), "informational");
    assert.strictEqual(kindOf("agent_completed"), "informational");
    assert.strictEqual(kindOf("elicitation_complete"), "informational");
    assert.strictEqual(kindOf("elicitation_response"), "informational");
  });

  test("counts background_tasks/session_crons, defaulting to zero when absent", () => {
    const busy = map({
      hook_event_name: "Stop",
      background_tasks: [mkBackgroundTask("t1"), mkBackgroundTask("t2")],
      session_crons: [mkSessionCron("c1")],
    });
    assert.strictEqual(busy.backgroundTaskCount, 2);
    assert.strictEqual(busy.sessionCronCount, 1);
    const idle = map({ hook_event_name: "Stop" });
    assert.strictEqual(idle.backgroundTaskCount, 0);
    assert.strictEqual(idle.sessionCronCount, 0);
  });
});

// Records the state at every needs-you ping (a session calls notify() past mute/focus suppression),
// standing in for the old onDidFinish observation now that AgentSession pings the service directly.
class RecordingNotifications extends NotificationService {
  readonly fired: string[] = [];
  override notify(session: AgentSession): void {
    this.fired.push(session.state);
  }
}

suite("AgentSessionService attention (needs-you ping / needsAttention)", () => {
  const ev = (event: string, toolName?: string): HookEventMessage =>
    mkHookEvent(event, { tool_name: toolName });

  const session = (svc: AgentSessionService) => svc.sessionsForRepo("/repo")[0];
  // Window not focused, so needs-you transitions DO mark/ping (the default reads the real window).
  // settle 0 → the stopped-edge ping fires synchronously in tests. `fired` records each ping's state.
  const mkSvc = (focused = false, settle = 0) => {
    const notifications = new RecordingNotifications();
    const svc = new AgentSessionService(claudeLocator, () => focused, settle, notifications);
    return { svc, fired: notifications.fired };
  };
  // Every ping is asynchronous (the gate fires on a macrotask even with settle 0) — tick to observe.
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("fires once on entering a needs-you state and sets needsAttention", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit"));
      assert.deepStrictEqual(fired, [], "busy states don't notify");
      ingestWire(svc, ev("Stop"));
      assert.deepStrictEqual(fired, [], "asynchronous — nothing fires inside the same tick");
      await tick();
      assert.deepStrictEqual(fired, ["stopped"]);
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("does NOT re-fire while staying within needs-you states", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("Stop")); // stopped (needs-you) — fires
      ingestWire(svc, ev("PermissionRequest")); // awaitingPermission (still needs-you) — no re-fire
      await tick();
      assert.strictEqual(fired.length, 1, "exactly one ping for the whole needs-you stretch");
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("clears on going busy/idle and re-arms on the next needs-you transition", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("Stop"));
      await tick();
      assert.strictEqual(session(svc).needsAttention, true);
      ingestWire(svc, ev("UserPromptSubmit")); // a new turn — clears
      assert.strictEqual(session(svc).needsAttention, false);
      ingestWire(svc, ev("PreToolUse", "ExitPlanMode")); // awaitingPlanApproval — re-arms + re-fires
      await tick();
      assert.deepStrictEqual(fired, ["stopped", "awaitingPlanApproval"]);
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("does NOT mark or fire when this window is focused", async () => {
    const { svc, fired } = mkSvc(true); // user is already looking at the editor
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("Stop"));
      await tick();
      assert.deepStrictEqual(fired, [], "no ping while focused");
      assert.strictEqual(session(svc).needsAttention, false, "no bell while focused");
    } finally {
      svc.dispose();
    }
  });

  const subEv = (event: string, toolName?: string): HookEventMessage =>
    mkHookEvent(event, { agent_id: "sub-1", tool_name: toolName });

  test("subagent events never change headline state or notify", () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit")); // thinking
      // A subagent (e.g. spawned during plan mode) hits a permission prompt / stop / question.
      ingestWire(svc, subEv("PermissionRequest"));
      ingestWire(svc, subEv("Stop"));
      ingestWire(svc, subEv("PreToolUse", "ExitPlanMode"));
      ingestWire(svc, subEv("Notification"));
      assert.deepStrictEqual(fired, [], "no notifications for subagent activity");
      assert.strictEqual(session(svc).needsAttention, false);
      assert.strictEqual(session(svc).state, "thinking", "headline state untouched by subagents");
    } finally {
      svc.dispose();
    }
  });

  test("a subagent event never even creates a parent row", () => {
    const { svc } = mkSvc();
    try {
      ingestWire(svc, subEv("PreToolUse", "Read")); // no top-level session has been seen yet
      assert.deepStrictEqual(svc.allSessions(), [], "subagent events are ignored outright");
    } finally {
      svc.dispose();
    }
  });

  test("a Notification (e.g. a question prompt) fires the needs-you ping", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit")); // thinking — not itself a needs-you state
      ingestWire(svc, ev("Notification")); // Claude is waiting for the user's input
      await tick();
      assert.strictEqual(fired.length, 1, "the question prompt pings once");
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("a Notification does not double-fire when already awaiting the user", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("PermissionRequest")); // awaitingPermission — fires once
      ingestWire(svc, ev("Notification")); // the matching notification — must not re-ping
      await tick();
      assert.strictEqual(fired.length, 1);
    } finally {
      svc.dispose();
    }
  });

  test("a typed Notification lands on the matching state (one ping via the state edge)", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit")); // thinking
      ingestWire(svc, mkHookEvent("Notification", { notification_type: "permission_prompt" }));
      await tick();
      assert.strictEqual(session(svc).state, "awaitingPermission");
      assert.strictEqual(fired.length, 1);
      ingestWire(svc, ev("PermissionRequest")); // the accompanying hook — same state, no second ping
      await tick();
      assert.strictEqual(fired.length, 1);
    } finally {
      svc.dispose();
    }
  });

  test("an informational Notification changes nothing and never pings", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit")); // thinking
      ingestWire(svc, mkHookEvent("Notification", { notification_type: "auth_success" }));
      await tick();
      assert.deepStrictEqual(fired, []);
      assert.strictEqual(session(svc).state, "thinking");
      assert.strictEqual(session(svc).needsAttention, false);
    } finally {
      svc.dispose();
    }
  });

  test("clearAttention drops the marker without a state change", async () => {
    const { svc } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("Stop"));
      await tick();
      assert.strictEqual(session(svc).needsAttention, true);
      svc.clearAttention("s1");
      assert.strictEqual(session(svc).needsAttention, false);
      assert.strictEqual(session(svc).state, "stopped", "state is untouched");
    } finally {
      svc.dispose();
    }
  });

  test("markIdleOnDisconnect also clears the marker", async () => {
    const { svc } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("PreToolUse", "ExitPlanMode"));
      await tick();
      assert.strictEqual(session(svc).needsAttention, true);
      svc.markIdleOnDisconnect("s1");
      assert.strictEqual(session(svc).needsAttention, false);
      assert.strictEqual(session(svc).state, "idle");
    } finally {
      svc.dispose();
    }
  });

  test("a muted session never pings or sets needsAttention", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      svc.setMuted("s1", true);
      ingestWire(svc, ev("Stop")); // needs-you edge, but the agent is muted
      await tick();
      assert.deepStrictEqual(fired, [], "muted agents don't ping");
      assert.strictEqual(session(svc).needsAttention, false);
      assert.strictEqual(session(svc).state, "stopped", "state is still tracked while muted");
    } finally {
      svc.dispose();
    }
  });

  test("muting a session with needsAttention=true clears the marker", async () => {
    const { svc } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("Stop"));
      await tick();
      assert.strictEqual(session(svc).needsAttention, true);
      svc.setMuted("s1", true);
      assert.strictEqual(session(svc).needsAttention, false, "muting drops a stale bell");
      assert.strictEqual(session(svc).muted, true);
    } finally {
      svc.dispose();
    }
  });

  test("unmuting re-arms the needs-you ping", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      svc.setMuted("s1", true);
      ingestWire(svc, ev("Stop")); // suppressed while muted
      await tick();
      assert.deepStrictEqual(fired, []);
      svc.setMuted("s1", false);
      ingestWire(svc, ev("UserPromptSubmit")); // a new turn
      ingestWire(svc, ev("PreToolUse", "ExitPlanMode")); // needs-you edge — now fires normally
      await tick();
      assert.deepStrictEqual(fired, ["awaitingPlanApproval"]);
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("setMuted on an unknown sessionId is a no-op", () => {
    const { svc } = mkSvc();
    try {
      svc.setMuted("missing", true); // must not throw
      assert.deepStrictEqual(svc.allSessions(), []);
    } finally {
      svc.dispose();
    }
  });
});

suite("AgentSessionService.activityForRepo (muted sessions excluded)", () => {
  const ev = (sessionId: string, event: string, toolName?: string): HookEventMessage =>
    mkHookEvent(event, { sessionId, tool_name: toolName });

  test("excludes a muted session from the busiest-state pick and needsAttention aggregate", () => {
    const svc = new AgentSessionService(claudeLocator, () => false);
    try {
      // s1 is muted while awaiting plan approval (a high-priority, needs-you state).
      ingestWire(svc, ev("s1", "SessionStart"));
      ingestWire(svc, ev("s1", "PreToolUse", "ExitPlanMode"));
      svc.setMuted("s1", true);
      // s2 is a visible, idle agent.
      ingestWire(svc, ev("s2", "SessionStart"));
      const act = svc.activityForRepo("/repo");
      assert.strictEqual(act.state, "idle", "the muted agent's state is ignored");
      assert.strictEqual(act.needsAttention, false, "the muted agent's attention is ignored");
    } finally {
      svc.dispose();
    }
  });

  test("a repo with only muted sessions reports a no-attention idle aggregate", () => {
    const svc = new AgentSessionService(claudeLocator, () => false);
    try {
      ingestWire(svc, ev("s1", "SessionStart"));
      ingestWire(svc, ev("s1", "PreToolUse", "ExitPlanMode"));
      svc.setMuted("s1", true);
      const act = svc.activityForRepo("/repo");
      assert.strictEqual(act.state, "idle");
      assert.strictEqual(act.needsAttention, false);
      assert.strictEqual(act.sessionCount, 1, "the muted agent is still listed/counted");
    } finally {
      svc.dispose();
    }
  });
});

suite("AgentSessionService background-agent stop gating", () => {
  const ev = (event: string, toolName?: string): HookEventMessage =>
    mkHookEvent(event, { tool_name: toolName });
  // SubagentStart/SubagentStop carry the parent session_id plus their own agent_id.
  const subEv = (event: string, agentId = "sub-1"): HookEventMessage =>
    mkHookEvent(event, { agent_id: agentId });
  const session = (svc: AgentSessionService) => svc.sessionsForRepo("/repo")[0];
  // settle 0 → the stopped-edge ping fires synchronously in tests. `fired` records each ping's state.
  const mkSvc = (settle = 0) => {
    const notifications = new RecordingNotifications();
    const svc = new AgentSessionService(claudeLocator, () => false, settle, notifications);
    return { svc, fired: notifications.fired };
  };

  test("a Stop with a background agent running is ignored outright — no ping, no state change", () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit")); // thinking
      ingestWire(svc, subEv("SubagentStart"));
      ingestWire(svc, ev("Stop"));
      assert.deepStrictEqual(fired, [], "no ping while a background agent runs");
      assert.strictEqual(session(svc).needsAttention, false);
      assert.strictEqual(session(svc).state, "thinking", "still working — the agent isn't done");
    } finally {
      svc.dispose();
    }
  });

  test("SubagentStop never pings by itself; the agent's own final Stop does", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit"));
      ingestWire(svc, subEv("SubagentStart", "sub-1"));
      ingestWire(svc, subEv("SubagentStart", "sub-2"));
      ingestWire(svc, ev("Stop")); // ignored — two still running
      ingestWire(svc, subEv("SubagentStop", "sub-1"));
      ingestWire(svc, ev("Stop")); // ignored — one still running
      ingestWire(svc, subEv("SubagentStop", "sub-2")); // last one done — still no ping (no deferral)
      await wait(0);
      assert.deepStrictEqual(fired, [], "only a real Stop pings, never a SubagentStop");
      ingestWire(svc, ev("Stop")); // the agent picks back up and emits its true final Stop
      await wait(0);
      assert.deepStrictEqual(fired, ["stopped"], "final Stop pings once");
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("an ignored Stop doesn't eat the next turn's ping", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, subEv("SubagentStart"));
      ingestWire(svc, ev("Stop")); // ignored
      ingestWire(svc, ev("UserPromptSubmit")); // new turn while the background agent still runs
      ingestWire(svc, subEv("SubagentStop"));
      ingestWire(svc, ev("Stop")); // normal turn end
      await wait(0);
      assert.deepStrictEqual(fired, ["stopped"], "pings exactly once");
    } finally {
      svc.dispose();
    }
  });

  test("SubagentStop with no prior start clamps at 0; a plain Stop still pings", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, subEv("SubagentStop")); // clamps at 0, never negative
      ingestWire(svc, ev("Stop"));
      await wait(0);
      assert.deepStrictEqual(fired, ["stopped"]);
    } finally {
      svc.dispose();
    }
  });

  test("SubagentStart for an unseen session creates no row", () => {
    const { svc } = mkSvc();
    try {
      ingestWire(svc, subEv("SubagentStart"));
      assert.deepStrictEqual(svc.allSessions(), []);
    } finally {
      svc.dispose();
    }
  });

  test("SubagentStart doesn't change headline state", () => {
    const { svc } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit")); // thinking
      ingestWire(svc, subEv("SubagentStart"));
      assert.strictEqual(session(svc).state, "thinking");
    } finally {
      svc.dispose();
    }
  });

  test("markIdleOnDisconnect zeroes the counter, so a later Stop pings (fail-open)", async () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit"));
      ingestWire(svc, subEv("SubagentStart")); // its SubagentStop will never arrive (interrupt)
      svc.markIdleOnDisconnect("s1");
      ingestWire(svc, ev("Stop"));
      await wait(0);
      assert.deepStrictEqual(fired, ["stopped"], "a wedged counter must not eat future pings");
    } finally {
      svc.dispose();
    }
  });

  test("SessionEnd clears active subagents", () => {
    const { svc } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, subEv("SubagentStart", "sub-1"));
      ingestWire(svc, subEv("SubagentStart", "sub-2"));
      ingestWire(svc, ev("SessionEnd"));
      assert.strictEqual(session(svc).hasActiveSubagents, false);
    } finally {
      svc.dispose();
    }
  });

  test("a subagent's own tool activity revives it after a premature SubagentStop", () => {
    const { svc, fired } = mkSvc();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("UserPromptSubmit")); // thinking
      ingestWire(svc, subEv("SubagentStart"));
      ingestWire(svc, subEv("SubagentStop")); // reported done...
      ingestWire(svc, subEv("PreToolUse")); // ...but it's still actually emitting tool activity
      ingestWire(svc, ev("Stop"));
      assert.deepStrictEqual(fired, [], "revived activity must still gate the stop ping");
      assert.strictEqual(session(svc).state, "thinking");
    } finally {
      svc.dispose();
    }
  });

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a quiet settle window releases the stop ping", async () => {
    const { svc, fired } = mkSvc(10);
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("Stop"));
      assert.deepStrictEqual(fired, [], "no instant ping — the settle window is still open");
      await wait(50);
      assert.deepStrictEqual(fired, ["stopped"], "quiet window → the ping fires");
      assert.strictEqual(session(svc).needsAttention, true);
    } finally {
      svc.dispose();
    }
  });

  test("resumed activity inside the settle window cancels the ping (wake-turn Stop)", async () => {
    const { svc, fired } = mkSvc(30);
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("Stop")); // intermediate stop — the agent picks back up below
      ingestWire(svc, ev("PreToolUse", "Task"));
      await wait(80);
      assert.deepStrictEqual(fired, [], "the resumed turn cancelled the pending ping");
    } finally {
      svc.dispose();
    }
  });

  test("a SubagentStart landing inside the settle window suppresses the ping", async () => {
    const { svc, fired } = mkSvc(30);
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, ev("Stop")); // count is 0 at event time…
      ingestWire(svc, subEv("SubagentStart")); // …but the spawn's events overtook the Stop on the socket
      await wait(80);
      assert.deepStrictEqual(fired, [], "count > 0 at fire time → skipped");
      // The parent resumes and truly finishes: the next full turn pings normally.
      ingestWire(svc, ev("PostToolUse", "Task"));
      ingestWire(svc, subEv("SubagentStop"));
      ingestWire(svc, ev("Stop"));
      await wait(80);
      assert.deepStrictEqual(fired, ["stopped"]);
    } finally {
      svc.dispose();
    }
  });
});

suite("summarizeActivity", () => {
  test("needsAttention wins over state", () => {
    const s = summarizeActivity({ sessionCount: 1, state: "thinking", needsAttention: true }, true);
    assert.match(s, /needs you/);
  });
  test("no sessions → idle", () => {
    assert.strictEqual(
      summarizeActivity({
        sessionCount: 0,
        state: "idle",
        needsAttention: false,
      }),
      "idle",
    );
  });
  test("renders the busy state with a codicon and agent count", () => {
    const s = summarizeActivity({
      sessionCount: 2,
      state: "thinking",
      needsAttention: false,
    });
    assert.match(s, /thinking/);
    assert.match(s, /2 agents/);
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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-activity-"));
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
      activity: { sessionCount: 1, state: "thinking" },
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

suite("open diff comparison stability", () => {
  test("editing a staged diff moves its tree location without changing its HEAD comparison", () => {
    assert.deepStrictEqual(
      markOpenDiffEdited({ repoRoot: "/repo", path: "src/a.ts", group: "staged", baseRef: "HEAD" }),
      { repoRoot: "/repo", path: "src/a.ts", group: "unstaged", baseRef: "HEAD" },
    );
  });

  test("editing a committed diff preserves its originally resolved comparison ref", () => {
    assert.deepStrictEqual(
      markOpenDiffEdited({
        repoRoot: "/repo",
        path: "src/a.ts",
        group: "committed",
        baseRef: "origin/main",
      }),
      { repoRoot: "/repo", path: "src/a.ts", group: "unstaged", baseRef: "origin/main" },
    );
  });
});

suite("Compare To picker defaults", () => {
  test("matches the persisted global comparison by kind and ref", () => {
    assert.strictEqual(compareToEqual({ kind: "mergeBase" }, { kind: "mergeBase" }), true);
    assert.strictEqual(
      compareToEqual({ kind: "ref", ref: "origin/main" }, { kind: "ref", ref: "origin/main" }),
      true,
    );
    assert.strictEqual(
      compareToEqual({ kind: "ref", ref: "origin/main" }, { kind: "ref", ref: "main" }),
      false,
    );
  });

  test("recovers the semantic tab comparison when concrete refs overlap", () => {
    assert.strictEqual(currentFileCompareKind("INDEX", "Index", "origin/main"), "index");
    assert.strictEqual(currentFileCompareKind("HEAD", "HEAD", "origin/main"), "head");
    assert.strictEqual(
      currentFileCompareKind("abc123", "merge-base(origin/main)", "origin/main"),
      "mergeBase",
    );
    assert.strictEqual(
      currentFileCompareKind("origin/main", "origin/main", "origin/main"),
      "default",
    );
    assert.strictEqual(currentFileCompareKind("feature", "feature", "origin/main"), "ref");
  });
});

suite("durable review comment attachments", () => {
  const changes = (overrides: Partial<ChangesModel>): ChangesModel => ({
    staged: [],
    unstaged: [],
    committed: [],
    compareLabel: "HEAD",
    compareRef: null,
    ...overrides,
  });
  const changed = (path: string, group: FileGroup, oldPath?: string): ChangedFile => ({
    path,
    oldPath,
    group,
    status: oldPath ? "R" : "M",
    additions: 1,
    deletions: 1,
  });

  test("a comment from Working Tree chooses that entry when the file is also staged", () => {
    const staged = changed("src/a.ts", "staged");
    const unstaged = changed("src/a.ts", "unstaged");
    assert.strictEqual(
      selectCommentFile(
        changes({ staged: [staged], unstaged: [unstaged] }),
        "src/a.ts",
        "unstaged",
      ),
      unstaged,
    );
  });

  test("a comment follows the file when its original Git group no longer exists", () => {
    const staged = changed("src/a.ts", "staged");
    assert.strictEqual(
      selectCommentFile(changes({ staged: [staged] }), "src/a.ts", "unstaged"),
      staged,
    );
  });

  test("a comment follows a detected rename", () => {
    const renamed = changed("src/new.ts", "unstaged", "src/old.ts");
    assert.strictEqual(
      selectCommentFile(changes({ unstaged: [renamed] }), "src/old.ts", "unstaged"),
      renamed,
    );
  });

  test("re-anchors an unchanged quoted line after lines are inserted above it", () => {
    assert.strictEqual(
      relocateReviewAnchor(["new", "before", "target", "after"], 1, {
        lineText: "target",
        contextBefore: ["before"],
        contextAfter: ["after"],
        lineHash: "unused",
      }),
      2,
    );
  });

  test("keeps a comment visible at a safe nearby line when its quoted line was rewritten", () => {
    assert.strictEqual(
      relocateReviewAnchor(["before", "rewritten", "after"], 1, {
        lineText: "target",
        contextBefore: ["before"],
        contextAfter: ["after"],
        lineHash: "unused",
      }),
      1,
    );
  });

  test("does not open a standalone file when the review diff already opened the target", () => {
    assert.strictEqual(shouldOpenStandaloneCommentTarget("review"), false);
    assert.strictEqual(shouldOpenStandaloneCommentTarget("fallback"), true);
  });
});

suite("WorkspaceRootCatalog repository ownership", () => {
  const folder = (
    overrides: Partial<{ rawRoot: string; canonicalRoot: string; gitRoot: string }>,
  ) => ({
    rawRoot: "/workspace",
    canonicalRoot: "/workspace",
    ...overrides,
  });

  test("admits nested repositories and submodules inside a workspace folder", () => {
    const workspace = folder({ gitRoot: "/workspace" });
    assert.strictEqual(
      relatedWorkspaceFolder("/workspace/packages/api", "/workspace/packages/api", [workspace]),
      workspace,
    );
  });

  test("admits an ancestor only when it is the folder's CLI-authoritative Git root", () => {
    const workspace = folder({
      rawRoot: "/repo/packages/api",
      canonicalRoot: "/repo/packages/api",
      gitRoot: "/repo",
    });
    assert.strictEqual(relatedWorkspaceFolder("/repo", "/repo", [workspace]), workspace);
  });

  test("rejects a false ancestor that disagrees with a worktree's CLI root", () => {
    const worktree = folder({
      rawRoot: "/repo-worktrees/feature",
      canonicalRoot: "/repo-worktrees/feature",
      gitRoot: "/repo-worktrees/feature",
    });
    assert.strictEqual(relatedWorkspaceFolder("/repo", "/repo", [worktree]), undefined);
  });
});

suite("pickCurrentRepo (deterministic repo selection)", () => {
  const repo = (root: string): RepoInfo => ({ uri: vscode.Uri.file(root) });
  const fileDoc = (fsPath: string) => ({ scheme: "file", fsPath });

  test("BUG REPRO: virtual active doc + workspace anchor picks the window's repo, not repos[0]", () => {
    const otherRepo = repo("/a/other");
    const windowRepo = repo("/a/window");
    const picked = pickCurrentRepo(
      [otherRepo, windowRepo],
      { scheme: "paireto-review", fsPath: "/a/other/x.ts" },
      "/a/window",
    );
    assert.strictEqual(picked, windowRepo);
  });

  test("no active doc falls back to the workspace-folder repo", () => {
    const otherRepo = repo("/a/other");
    const windowRepo = repo("/a/window");
    assert.strictEqual(
      pickCurrentRepo([otherRepo, windowRepo], undefined, "/a/window"),
      windowRepo,
    );
  });

  test("active file: doc inside a repo beats the workspace anchor", () => {
    const otherRepo = repo("/a/other");
    const windowRepo = repo("/a/window");
    assert.strictEqual(
      pickCurrentRepo([otherRepo, windowRepo], fileDoc("/a/other/x.ts"), "/a/window"),
      otherRepo,
    );
  });

  test("nested roots pick the longest (worktree inside main repo)", () => {
    const main = repo("/a/repo");
    const worktree = repo("/a/repo/wt");
    assert.strictEqual(
      pickCurrentRepo([main, worktree], fileDoc("/a/repo/wt/src/x.ts"), "/a/repo"),
      worktree,
    );
  });

  test("startsWith trap: /a/repo must not claim /a/repo-two/x.ts", () => {
    const repoOne = repo("/a/repo");
    const repoTwo = repo("/a/repo-two");
    assert.strictEqual(
      pickCurrentRepo([repoOne, repoTwo], fileDoc("/a/repo-two/x.ts"), undefined),
      repoTwo,
    );
  });

  test("workspace folder exactly equal to a root matches", () => {
    const repoOne = repo("/a/repo");
    assert.strictEqual(pickCurrentRepo([repoOne], undefined, "/a/repo"), repoOne);
  });

  test("empty repos -> undefined", () => {
    assert.strictEqual(pickCurrentRepo([], fileDoc("/a/repo/x.ts"), "/a/repo"), undefined);
  });

  test("no anchors at all -> repos[0]", () => {
    const first = repo("/a/first");
    const second = repo("/a/second");
    assert.strictEqual(pickCurrentRepo([first, second], undefined, undefined), first);
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

suite("resolveAutoReveal (honours explorer.autoReveal)", () => {
  const explorer = () => vscode.workspace.getConfiguration("explorer");
  let original: unknown;
  suiteSetup(() => {
    original = explorer().get("autoReveal");
  });
  suiteTeardown(async () => {
    await explorer().update("autoReveal", original, vscode.ConfigurationTarget.Global);
  });
  const withSetting = async (value: unknown, expected: boolean | "focusNoScroll") => {
    await explorer().update("autoReveal", value, vscode.ConfigurationTarget.Global);
    assert.strictEqual(getAutoRevealSetting(), expected);
  };

  test("false disables reveal-on-focus (falsy)", () => withSetting(false, false));
  test("true keeps reveal on", () => withSetting(true, true));
  test('"focusNoScroll" is preserved (still truthy, so reveal stays on)', () =>
    withSetting("focusNoScroll", "focusNoScroll"));
});

suite("shouldOpenTurnEndReview (turn-end review gate)", () => {
  const base = {
    reviewInProgress: false,
    changedThisTurn: false,
    hasComments: false,
    automatic: true,
  };
  test("opens a review when the agent's turn edited files", () => {
    assert.strictEqual(shouldOpenTurnEndReview({ ...base, changedThisTurn: true }), true);
  });
  test("opens a review when the user has comments to deliver", () => {
    assert.strictEqual(shouldOpenTurnEndReview({ ...base, hasComments: true }), true);
  });
  test("does NOT open a review for a turn that changed nothing (no uncommitted-changes fallback)", () => {
    assert.strictEqual(shouldOpenTurnEndReview(base), false);
  });
  test("stays out of the way while a review is already in progress", () => {
    assert.strictEqual(
      shouldOpenTurnEndReview({ ...base, changedThisTurn: true, reviewInProgress: true }),
      false,
    );
  });
  test("manual mode: edits alone do NOT open a review", () => {
    assert.strictEqual(
      shouldOpenTurnEndReview({ ...base, automatic: false, changedThisTurn: true }),
      false,
    );
  });
  test("manual mode: queued comments still open a review", () => {
    assert.strictEqual(
      shouldOpenTurnEndReview({ ...base, automatic: false, hasComments: true }),
      true,
    );
  });
});

suite("AgentSessionService.turnState (Stop-gate signal)", () => {
  const ev = (event: string, toolName?: string): HookEventMessage =>
    mkHookEvent(event, { tool_name: toolName });
  const mk = () => new AgentSessionService(claudeLocator, () => false);

  test("an edit-class tool marks the turn as having touched files", () => {
    const svc = mk();
    try {
      ingestWire(svc, ev("UserPromptSubmit"));
      assert.strictEqual(svc.turnState("s1").changedThisTurn, false);
      ingestWire(svc, ev("PreToolUse", "Edit"));
      ingestWire(svc, ev("PostToolUse", "Edit"));
      assert.strictEqual(svc.turnState("s1").changedThisTurn, true);
    } finally {
      svc.dispose();
    }
  });

  test("a read-only tool does not mark the turn", () => {
    const svc = mk();
    try {
      ingestWire(svc, ev("UserPromptSubmit"));
      ingestWire(svc, ev("PostToolUse", "Read"));
      assert.strictEqual(svc.turnState("s1").changedThisTurn, false);
    } finally {
      svc.dispose();
    }
  });

  test("a new turn (UserPromptSubmit) resets the flag", () => {
    const svc = mk();
    try {
      ingestWire(svc, ev("PostToolUse", "Write"));
      assert.strictEqual(svc.turnState("s1").changedThisTurn, true);
      ingestWire(svc, ev("UserPromptSubmit"));
      assert.strictEqual(svc.turnState("s1").changedThisTurn, false);
    } finally {
      svc.dispose();
    }
  });

  test("hasPendingWork reflects a Task-tool subagent believed still active", () => {
    const svc = mk();
    try {
      ingestWire(svc, ev("SessionStart"));
      assert.strictEqual(svc.turnState("s1").hasPendingWork, false);
      ingestWire(svc, mkHookEvent("SubagentStart", { agent_id: "sub-1" }));
      assert.strictEqual(svc.turnState("s1").hasPendingWork, true);
      ingestWire(svc, mkHookEvent("SubagentStop", { agent_id: "sub-1" }));
      assert.strictEqual(svc.turnState("s1").hasPendingWork, false);
    } finally {
      svc.dispose();
    }
  });

  test("hasPendingWork reflects background_tasks/session_crons on a Stop event, with no SubagentStart/Stop at all", () => {
    // The scenario a plain SubagentStart/Stop counter can't see: an async-launched (background
    // Agent-tool) subagent emits no subagent-related hook events — only the top-level Stop's own
    // background_tasks count (Claude Code v2.1.145+) reveals it's still running.
    const svc = mk();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(
        svc,
        mkHookEvent("Stop", { background_tasks: [mkBackgroundTask("t1"), mkBackgroundTask("t2")] }),
      );
      assert.strictEqual(svc.turnState("s1").hasPendingWork, true);
      ingestWire(svc, mkHookEvent("Stop", { background_tasks: [] }));
      assert.strictEqual(svc.turnState("s1").hasPendingWork, false);
    } finally {
      svc.dispose();
    }
  });

  test("hasPendingWork reflects session_crons on a Stop event", () => {
    const svc = mk();
    try {
      ingestWire(svc, ev("SessionStart"));
      ingestWire(svc, mkHookEvent("Stop", { session_crons: [mkSessionCron("c1")] }));
      assert.strictEqual(svc.turnState("s1").hasPendingWork, true);
    } finally {
      svc.dispose();
    }
  });

  test("noteBackgroundWork (blocking stop.gate.request path) feeds the same session state", () => {
    const svc = mk();
    try {
      ingestWire(svc, ev("SessionStart"));
      svc.noteBackgroundWork("s1", { backgroundTaskCount: 1, sessionCronCount: 0 });
      assert.strictEqual(svc.turnState("s1").hasPendingWork, true);
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

suite("describeInbound (bridge debug log line)", () => {
  const base = { v: "1", ts: "t" };
  const locator = new AgentServiceLocator();

  test("hook events show event, agent, and the interesting extras", () => {
    assert.strictEqual(
      createInboundEventLog(
        {
          ...base,
          t: "hook.event",
          harness: "claudecode",
          repoRoot: "/x",
          event: { hook_event_name: "PreToolUse", session_id: "72a4f124-aaaa", tool_name: "Edit" },
        } as AnyMessage,
        locator,
      ),
      "hook.event PreToolUse agent=72a4f124 tool=Edit",
    );
  });

  test("subagent context and notification type are called out", () => {
    assert.strictEqual(
      createInboundEventLog(
        {
          ...base,
          t: "hook.event",
          harness: "claudecode",
          repoRoot: "/x",
          event: {
            hook_event_name: "Notification",
            session_id: "72a4f124-aaaa",
            agent_id: "abcd1234-bbbb",
            notification_type: "permission_prompt",
          },
        } as AnyMessage,
        locator,
      ),
      "hook.event Notification agent=72a4f124 subagent=abcd1234 type=permission_prompt",
    );
  });

  test("an unrecognized harness falls back to the wire type alone (no dialect to render)", () => {
    // A wire harness value outside the closed Harness union (e.g. an unknown plugin) — strategyForWire
    // returns undefined, so there's no dialect renderer and we log the wire type alone.
    assert.strictEqual(
      createInboundEventLog(
        {
          ...base,
          t: "hook.event",
          harness: "geminicli",
          repoRoot: "/x",
          event: { hook_event_name: "PreToolUse", session_id: "72a4f124-aaaa", tool_name: "Edit" },
        } as unknown as AnyMessage,
        locator,
      ),
      "hook.event",
    );
  });

  test("non-hook messages show the type and agent", () => {
    assert.strictEqual(
      createInboundEventLog(
        {
          ...base,
          t: "session.attach",
          sessionId: "72a4f124-aaaa",
          repoRoot: "/x",
        } as AnyMessage,
        locator,
      ),
      "session.attach agent=72a4f124",
    );
  });
});

suite("commandSession (inline tree buttons receive the Node, row clicks the session)", () => {
  const session = { sessionId: "s1", repoRoot: "/repo" } as AgentSession;

  test("unwraps an agent tree node (inline eye/focus buttons)", () => {
    assert.strictEqual(commandSession({ kind: "agent", session }), session);
  });

  test("passes a raw session through (row-click command args)", () => {
    assert.strictEqual(commandSession(session), session);
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

suite("agentLabel (harness name + short id)", () => {
  test("prefixes the harness display name", () => {
    assert.strictEqual(agentLabel("Claude", "a1b2c3d4-e5f6-7890"), "Claude (a1b2c3d4)");
  });

  test("uses whatever display name it's given (a non-Claude harness)", () => {
    assert.strictEqual(agentLabel("Fake", "a1b2c3d4-e5f6-7890"), "Fake (a1b2c3d4)");
  });
});

suite("computeViewBadge (activity-bar ticker)", () => {
  test("shows the changed-file count", () => {
    const badge = computeViewBadge(3);
    assert.strictEqual(badge?.value, 3);
    assert.strictEqual(badge!.tooltip, "3 changed files");
  });

  test("singular file wording", () => {
    assert.strictEqual(computeViewBadge(1)?.tooltip, "1 changed file");
  });

  test("no badge when there are no changes", () => {
    assert.strictEqual(computeViewBadge(0), undefined);
  });
});

suite("repositoryBranchLabel", () => {
  test("shows the repository's current branch", () => {
    assert.strictEqual(repositoryBranchLabel("feature/multi-root"), "feature/multi-root");
  });

  test("labels a detached HEAD explicitly", () => {
    assert.strictEqual(repositoryBranchLabel(undefined), "(detached)");
  });
});

suite("changedFileCount (matches the Git panel)", () => {
  test("counts a partially-staged file in both sections (no dedup)", () => {
    // src/a.ts is staged AND has further unstaged edits — the Git panel shows it in both groups.
    const staged = [{ path: "src/a.ts" }, { path: "src/b.ts" }];
    const unstaged = [{ path: "src/a.ts" }];
    assert.strictEqual(changedFileCount(staged, unstaged), 3);
  });

  test("sums the two sections", () => {
    assert.strictEqual(changedFileCount([{ path: "x" }], [{ path: "y" }, { path: "z" }]), 3);
  });
});

suite("pickAuthorName (comment author fallback chain)", () => {
  test("prefers the VS Code signed-in account label", () => {
    assert.strictEqual(pickAuthorName("Ada Lovelace", "ada"), "Ada Lovelace");
  });

  test("falls back to the OS username when not signed in", () => {
    assert.strictEqual(pickAuthorName(undefined, "ada"), "ada");
  });

  test("falls back to Developer when nothing is available", () => {
    assert.strictEqual(pickAuthorName(undefined, undefined), "Developer");
  });

  test("ignores blank values", () => {
    assert.strictEqual(pickAuthorName("   ", "  "), "Developer");
  });
});

// Proves the shared core (AgentSession state machine + notify path, the locator, plan-approve mode)
// is genuinely harness-agnostic: driving it with a REAL non-Claude harness (Codex) off synthetic
// AppEvents — using Codex's own tool names — exercises identical behaviour with no Claude specifics.
// No fake strategy is registered: the seam is exercised through the production locator's real map.
suite("AgentStrategy agnosticism (a second, non-Claude harness)", () => {
  const CODEX: Harness = "codex";
  const locator = new AgentServiceLocator();

  const mk = (kind: AppEventKind, extra: Partial<AppEvent> = {}): AppEvent => ({
    kind,
    harness: CODEX,
    sessionId: "s1",
    backgroundTaskCount: 0,
    sessionCronCount: 0,
    ...extra,
  });
  const mkSvc = (focused = false) => {
    const notifications = new RecordingNotifications();
    const svc = new AgentSessionService(locator, () => focused, 0, notifications);
    return { svc, fired: notifications.fired };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("the same state machine + notify path runs for a non-Claude harness", async () => {
    const { svc, fired } = mkSvc();
    try {
      svc.ingest(mk("sessionStart"), "/repo");
      svc.ingest(mk("userPromptSubmit"), "/repo");
      svc.ingest(mk("preToolUse", { toolName: "apply_patch" }), "/repo");
      const session = svc.sessionsForRepo("/repo")[0];
      assert.strictEqual(session.state, "toolRunning");
      assert.strictEqual(session.lastTool, "apply_patch");
      assert.strictEqual(session.harness, CODEX);
      svc.ingest(mk("planProposal"), "/repo");
      assert.strictEqual(session.state, "awaitingPlanApproval");
      await tick();
      assert.deepStrictEqual(fired, ["awaitingPlanApproval"]);
    } finally {
      svc.dispose();
    }
  });

  test("isEditTool marks the turn regardless of the (non-Claude) tool name", () => {
    const { svc } = mkSvc();
    try {
      svc.ingest(mk("userPromptSubmit"), "/repo");
      svc.ingest(mk("postToolUse", { toolName: "shell", isEditTool: false }), "/repo");
      assert.strictEqual(svc.turnState("s1").changedThisTurn, false);
      svc.ingest(mk("postToolUse", { toolName: "apply_patch", isEditTool: true }), "/repo");
      assert.strictEqual(svc.turnState("s1").changedThisTurn, true);
    } finally {
      svc.dispose();
    }
  });

  test("subagent gating works for a non-Claude harness", () => {
    const { svc } = mkSvc();
    try {
      svc.ingest(mk("sessionStart"), "/repo");
      assert.strictEqual(svc.turnState("s1").hasPendingWork, false);
      svc.ingest(mk("subagentStart", { agentId: "sub-1" }), "/repo");
      assert.strictEqual(svc.turnState("s1").hasPendingWork, true);
      svc.ingest(mk("subagentStop", { agentId: "sub-1" }), "/repo");
      assert.strictEqual(svc.turnState("s1").hasPendingWork, false);
    } finally {
      svc.dispose();
    }
  });

  test("a notification maps onto the state machine + pings", async () => {
    const { svc, fired } = mkSvc();
    try {
      svc.ingest(mk("sessionStart"), "/repo");
      svc.ingest(mk("userPromptSubmit"), "/repo");
      svc.ingest(mk("notification", { notificationKind: "permissionPrompt" }), "/repo");
      assert.strictEqual(svc.sessionsForRepo("/repo")[0].state, "awaitingPermission");
      await tick();
      assert.deepStrictEqual(fired, ["awaitingPermission"]);
    } finally {
      svc.dispose();
    }
  });

  test("the locator resolves every registered harness independently", () => {
    assert.strictEqual(locator.strategyFor("claudecode").displayName, "Claude");
    assert.strictEqual(locator.strategyFor("codex").displayName, "Codex");
    assert.strictEqual(locator.strategyFor("opencode").displayName, "OpenCode");
    assert.strictEqual(locator.strategyForWire("codex")?.displayName, "Codex");
    assert.strictEqual(locator.strategyForWire("nope"), undefined);
    // The agent-row label reflects the resolved harness's own display name.
    assert.strictEqual(
      agentLabel(locator.strategyFor("codex").displayName, "abcd1234-xyz"),
      "Codex (abcd1234)",
    );
  });

  test("plan-approve mode honors the harness config key, else the strategy default", () => {
    const claudeDefault = locator.strategyFor("claudecode").defaultPlanApproveMode; // "auto"
    const codexDefault = locator.strategyFor("codex").defaultPlanApproveMode; // undefined
    // An explicit per-harness config value wins over the strategy default.
    assert.strictEqual(resolvePlanApproveMode("default", claudeDefault), "default");
    // Absent config → the strategy's own default.
    assert.strictEqual(resolvePlanApproveMode(undefined, claudeDefault), "auto");
    // "off" → leave the mode unchanged.
    assert.strictEqual(resolvePlanApproveMode("off", claudeDefault), undefined);
    // A harness with no settable mode at all (Codex).
    assert.strictEqual(resolvePlanApproveMode(undefined, codexDefault), undefined);
  });
});
