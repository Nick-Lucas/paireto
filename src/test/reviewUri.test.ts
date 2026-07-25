// Breadcrumb/tab-path shape of review URIs. VS Code renders breadcrumbs and tab paths from the URI
// path segments, so the URI *path* must be the workspace-relative path of the real file — never a
// synthetic "/base/…" or "/modified/…" prefix. Everything the provider and comment anchoring need
// (side, repo-relative path, ref, repo) rides in the query instead. ReviewPath owns both directions.

import * as assert from "node:assert";
import { realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { ReviewContentProvider } from "../review/ReviewContentProvider.js";
import { ReviewPath } from "../review/ReviewPath.js";
import { Schemes } from "../config.js";

suite("review URI shape (breadcrumbs)", () => {
  test("URI path is the file path with no side segment", () => {
    const uri = ReviewPath.create({
      reviewId: "rev1",
      side: "modified",
      relPath: "src/foo/bar.ts",
      ref: "WORKING",
      repoRoot: "/repo",
    }).toUri();
    const first = uri.path.replace(/^\//, "").split("/")[0];
    assert.notStrictEqual(first, "modified", "breadcrumbs must not start with the side marker");
    assert.notStrictEqual(first, "base", "breadcrumbs must not start with the side marker");
    assert.ok(uri.path.endsWith("src/foo/bar.ts"), `path must end with the file path: ${uri.path}`);
  });

  test("base and modified sides of one diff stay distinct URIs (same ref)", () => {
    const file = { reviewId: "rev1", relPath: "a.ts", ref: "HEAD", repoRoot: "/repo" } as const;
    const base = ReviewPath.create({ ...file, side: "base" }).toUri();
    const modified = ReviewPath.create({ ...file, side: "modified" }).toUri();
    assert.notStrictEqual(base.toString(), modified.toString());
  });

  test("provider resolves content from the query, not the URI path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paireto-uri-"));
    const provider = new ReviewContentProvider();
    try {
      await fs.writeFile(path.join(dir, "file.txt"), "hello breadcrumbs");
      // Hand-built new-shape URI: display path in the URI path, identity in the query.
      const uri = vscode.Uri.from({
        scheme: Schemes.review,
        authority: "rev1",
        path: "/file.txt",
        query: new URLSearchParams({
          side: "modified",
          path: "file.txt",
          ref: "WORKING",
          repo: encodeURIComponent(dir),
        }).toString(),
      });
      const bytes = await provider.readFile(uri);
      assert.strictEqual(Buffer.from(bytes).toString("utf8"), "hello breadcrumbs");
    } finally {
      provider.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("in-workspace repos shape the URI path via the workspace folders, not the relPath fallback", () => {
    // Uses the harness's real fixture workspace: a repoRoot one level below the folder makes the
    // workspace-relative display ("sub/x.ts") observably different from the relPath fallback
    // ("x.ts"), pinning that toUri actually reads the live workspaceFolders.
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "the test harness must open the fixture workspace");
    const repoRoot = path.join(realpathSync(folder.uri.fsPath), "sub");
    const uri = ReviewPath.create({
      reviewId: "rev1",
      side: "modified",
      relPath: "x.ts",
      ref: "WORKING",
      repoRoot,
    }).toUri();
    assert.strictEqual(uri.path, "/sub/x.ts");
  });

  test("side/relPath/ref/repo round-trip through the query (comment anchoring input)", () => {
    const uri = ReviewPath.create({
      reviewId: "rev1",
      side: "base",
      relPath: "src/a dir/c.ts",
      ref: "INDEX",
      repoRoot: "/some/repo",
    }).toUri();
    const parsed = ReviewPath.fromUri(uri);
    assert.strictEqual(parsed.reviewId, "rev1");
    assert.strictEqual(parsed.side, "base");
    assert.strictEqual(parsed.relPath, "src/a dir/c.ts");
    assert.strictEqual(parsed.ref, "INDEX");
    assert.strictEqual(parsed.repoRoot, "/some/repo");
  });
});

suite("ReviewPath.displayPath (breadcrumb labeling)", () => {
  const single = [{ name: "app", fsPath: "/ws/app" }];
  const multi = [
    { name: "app", fsPath: "/ws/app" },
    { name: "lib", fsPath: "/ws/lib" },
  ];

  function displayPath(
    repoRoot: string,
    relPath: string,
    folders: readonly { name: string; fsPath: string }[],
  ): string {
    return ReviewPath.create({
      reviewId: "rev1",
      side: "modified",
      relPath,
      ref: "WORKING",
      repoRoot,
    }, folders).displayPath();
  }

  test("single-root: path relative to the folder, no folder-name prefix", () => {
    assert.strictEqual(displayPath("/ws/app", "src/x.ts", single), "src/x.ts");
  });

  test("multi-root: folder name is the first segment", () => {
    assert.strictEqual(displayPath("/ws/lib", "src/y.ts", multi), "lib/src/y.ts");
  });

  test("outside every folder: falls back to the repo-relative path", () => {
    assert.strictEqual(displayPath("/elsewhere", "z.ts", multi), "z.ts");
  });

  test("nested folders: the closest containing folder wins, like asRelativePath", () => {
    const nested = [
      { name: "repo", fsPath: "/ws/repo" },
      { name: "lib", fsPath: "/ws/repo/packages/lib" },
    ];
    assert.strictEqual(displayPath("/ws/repo", "packages/lib/src/x.ts", nested), "lib/src/x.ts");
    assert.strictEqual(displayPath("/ws/repo", "src/x.ts", nested), "repo/src/x.ts");
  });

  test("a symlinked workspace folder still matches its canonical repo path", async () => {
    // macOS /var vs /private/var: the folder is the user-opened (possibly symlinked) path while
    // repoRoot is git-canonicalized — the two must still pair up or the folder prefix silently
    // drops and two repos' same-named files get indistinguishable breadcrumbs.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paireto-display-"));
    try {
      await fs.mkdir(path.join(dir, "real", "src"), { recursive: true });
      await fs.writeFile(path.join(dir, "real", "src", "x.ts"), "");
      await fs.symlink(path.join(dir, "real"), path.join(dir, "linked"));
      const folders = [
        { name: "app", fsPath: path.join(dir, "linked") },
        { name: "other", fsPath: "/elsewhere" },
      ];
      const canonical = realpathSync(path.join(dir, "real"));
      assert.strictEqual(displayPath(canonical, "src/x.ts", folders), "app/src/x.ts");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
