import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentState, FileGroup } from "../types.js";
import { FilesArg, readArg } from "../review/commandArgs.js";
import type { RepoChangedFile, ReviewState } from "../review/ReviewController.js";
import { buildSidebarState, fileNodeId, type SidebarSnapshot } from "../views/sidebarModel.js";
import type { SidebarNode, SidebarOperation } from "../views/sidebarProtocol.js";

const REPO = "/workspace/repo";

function changed(pathname: string, group: FileGroup): RepoChangedFile {
  return {
    path: pathname,
    status: "M",
    group,
    additions: 3,
    deletions: 1,
    repoRoot: REPO,
  };
}

function review(files: RepoChangedFile[] = []): ReviewState {
  return {
    compareTo: { kind: "head" },
    layout: "tree",
    repositories: [
      {
        repoRoot: REPO,
        displayName: "repo",
        branch: "feature/webview",
        changes: {
          staged: files.filter((file) => file.group === "staged"),
          unstaged: files.filter((file) => file.group === "unstaged"),
          committed: files.filter((file) => file.group === "committed"),
          compareLabel: "HEAD",
          compareRef: null,
        },
      },
    ],
  };
}

function snapshot(overrides: Partial<SidebarSnapshot> = {}): SidebarSnapshot {
  return {
    agents: [],
    review: review(),
    planPending: false,
    planComments: [],
    reviewSessionActive: false,
    reviewComments: [],
    ...overrides,
  };
}

function section(state: ReturnType<typeof buildSidebarState>, label: string): SidebarNode {
  const node = state.nodes.find((candidate) => candidate.label === label);
  assert.ok(node, `missing ${label} section`);
  return node;
}

function operations(node: SidebarNode): SidebarOperation[] {
  return [...(node.inlineActions ?? []), ...(node.menuActions ?? [])].map(
    (action) => action.operation,
  );
}

suite("sidebar webview contribution", () => {
  test("contributes a webview and does not keep TreeView item menus", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    ) as {
      contributes: {
        views: { paireto: Array<{ id: string; type: string }> };
        menus: Record<string, unknown>;
      };
    };
    const view = manifest.contributes.views.paireto.find((item) => item.id === "paireto.main");
    assert.strictEqual(view?.type, "webview");
    assert.strictEqual(manifest.contributes.menus["view/item/context"], undefined);
  });

  test("uses VS Code's native webview context menu", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8"),
    ) as { contributes: { menus: Record<string, Array<{ when?: string }>> } };
    const items = manifest.contributes.menus["webview/context"];
    assert.ok(items?.length);
    assert.ok(items.every((item) => item.when?.includes("webviewId == paireto.main")));
  });

  test("matches the native custom TreeView dimensions and tokens", () => {
    const css = fs.readFileSync(
      path.join(__dirname, "../../src/views/webview/sidebar.css"),
      "utf8",
    );
    assert.match(css, /\.tree-row\s*\{[^}]*height:\s*22px/s);
    assert.match(css, /\.tree-row\s*\{[^}]*padding-right:\s*12px/s);
    assert.match(css, /\.tree-row\s*\{[^}]*cursor:\s*pointer/s);
    assert.match(css, /\.twisty\s*\{[^}]*padding-right:\s*6px/s);
    assert.match(css, /\.twisty\s*\{[^}]*transform:\s*translateX\(3px\)/s);
    assert.match(css, /\.node-icon\s*\{[^}]*width:\s*16px[^}]*height:\s*22px/s);
    assert.match(css, /\.node-icon\s*\{[^}]*padding-right:\s*6px/s);
    assert.match(css, /\.description\s*\{[^}]*opacity:\s*0\.7/s);
    assert.match(css, /\.description\s*\{[^}]*margin-left:\s*0\.5em/s);
    assert.doesNotMatch(css, /text-transform:\s*uppercase/);
    assert.doesNotMatch(css, /\.context-menu/);
    assert.match(css, /var\(--vscode-cornerRadius-medium/);
  });

  test("loads the running VS Code build's Codicon font", () => {
    const provider = fs.readFileSync(
      path.join(__dirname, "../../src/views/MainWebviewProvider.ts"),
      "utf8",
    );
    assert.match(provider, /vscode\.env\.appRoot/);
    assert.match(provider, /codicon\.ttf/);
    assert.match(provider, /@font-face/);
  });
});

suite("sidebar webview model", () => {
  test("shows the standard sections and file controls", () => {
    const file = changed("src/nested/file.ts", "unstaged");
    const state = buildSidebarState(snapshot({ review: review([file]) }));

    assert.deepStrictEqual(
      state.nodes.map((node) => node.label),
      ["Agents", "Changed Files"],
    );
    const files = section(state, "Changed Files");
    assert.deepStrictEqual(
      files.inlineActions?.map((action) => action.operation),
      ["pickCompareTo", "toggleLayout"],
    );
    const group = files.children?.find((node) => node.label === "Working Tree");
    assert.ok(group);
    assert.ok(operations(group).includes("discardFiles"));
    assert.ok(operations(group).includes("stageFiles"));
    assert.deepStrictEqual(group.inlineActions?.[0].target, {
      kind: "files",
      repoRoot: REPO,
      group: "unstaged",
    });
    const folder = group.children?.[0];
    assert.strictEqual(folder?.label, "src/nested");
    assert.ok(operations(folder).includes("discardFiles"));
    assert.ok(operations(folder).includes("stageFiles"));
    assert.deepStrictEqual(folder.inlineActions?.[0].target, {
      kind: "files",
      repoRoot: REPO,
      group: "unstaged",
      pathPrefix: "src/nested",
    });
    const fileRow = folder.children?.[0];
    assert.strictEqual(fileRow?.label, "file.ts");
    assert.strictEqual(fileRow?.primaryAction?.operation, "openDiff");
    assert.ok(operations(fileRow).includes("openFile"));
    assert.ok(operations(fileRow).includes("discardFiles"));
    assert.ok(operations(fileRow).includes("stageFiles"));
    assert.strictEqual(state.badge, 1);
  });

  test("accepts the serializable file list resolved by the host bridge", () => {
    const files = [changed("a.ts", "unstaged"), changed("b.ts", "unstaged")];
    assert.deepStrictEqual(
      readArg(FilesArg, files)?.map((file) => file.path),
      ["a.ts", "b.ts"],
    );
  });

  test("marks the active diff row for React selection and reveal", () => {
    const file = changed("src/file.ts", "unstaged");
    const state = buildSidebarState(
      snapshot({
        review: review([file]),
        activeDiff: { repoRoot: REPO, group: "unstaged", path: file.path },
      }),
    );
    assert.strictEqual(state.selectedNodeId, fileNodeId(file));
  });

  test("keeps every agent action and gate state", () => {
    const agent = {
      sessionId: "a1b2c3d4-e5f6",
      displayName: "Codex",
      repoRoot: REPO,
      state: "awaitingInput" as AgentState,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      needsAttention: true,
      muted: false,
      gate: { kind: "review" as const, foreground: false },
    };
    const row = section(buildSidebarState(snapshot({ agents: [agent] })), "Agents").children?.[0];
    assert.strictEqual(row?.label, "Codex (a1b2c3d4)");
    assert.match(row?.description ?? "", /awaiting code review/);
    assert.strictEqual(row?.primaryAction?.operation, "switchAgent");
    assert.deepStrictEqual(
      row?.inlineActions?.map((action) => action.operation),
      ["focusAgent", "hideAgent"],
    );
  });

  test("replaces Changed Files with the ordered guided review", () => {
    const first = changed("z.ts", "unstaged");
    const second = changed("a.ts", "staged");
    const base = review([first, second]);
    base.guided = {
      repoRoot: REPO,
      compareTo: { kind: "head" },
      changesets: [
        {
          id: "cs0",
          title: "One change",
          description: "Read these in order.",
          files: [
            { changesetId: "cs0", path: first.path, file: first },
            { changesetId: "cs0", path: second.path, file: second },
          ],
          missingCount: 0,
          stageableCount: 1,
          unstageableCount: 1,
        },
      ],
      fileTotal: 2,
      missingTotal: 0,
    };
    const state = buildSidebarState(snapshot({ review: base }));
    assert.strictEqual(
      state.nodes.some((node) => node.label === "Changed Files"),
      false,
    );
    const plan = section(state, "Review Plan");
    assert.strictEqual(plan.primaryAction?.operation, "openReviewPlan");
    const changeset = plan.children?.[0];
    assert.deepStrictEqual(
      changeset?.children?.map((node) => node.label),
      ["z.ts", "a.ts"],
    );
    assert.ok(operations(changeset).includes("stageChangeset"));
    assert.ok(operations(changeset).includes("unstageChangeset"));
  });

  test("shows setup, plan comments, and review feedback actions", () => {
    const state = buildSidebarState(
      snapshot({
        setupPrompt: { kind: "update", agentNames: ["Codex"] },
        planPending: true,
        planComments: [{ line: 2, quote: "old", body: "Explain this", kind: "question" }],
        reviewSessionActive: true,
        reviewComments: [
          {
            id: "comment-1",
            repoRoot: REPO,
            filePath: "src/a.ts",
            side: "modified",
            line: 4,
            kind: "problem",
            body: "This can fail",
            quote: "run()",
            anchor: { lineText: "run()", contextBefore: [], contextAfter: [], lineHash: "x" },
          },
        ],
      }),
    );
    assert.strictEqual(state.nodes[0].primaryAction?.operation, "openWelcome");
    assert.strictEqual(section(state, "Plan Review").children?.[0].label, "Line 3");
    const feedback = section(state, "Feedback").children?.[0];
    assert.strictEqual(feedback?.primaryAction?.operation, "revealComment");
    assert.deepStrictEqual(
      feedback?.inlineActions?.map((action) => action.operation),
      ["deleteComment"],
    );
  });
});
