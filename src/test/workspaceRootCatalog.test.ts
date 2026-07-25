import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import type { RepoInfo } from "../git/RepoService.js";
import {
  WorkspaceRootCatalog,
  repoRelativePath,
  type WorkspaceRootCatalogEnvironment,
} from "../git/WorkspaceRootCatalog.js";
import { canonicalize } from "../protocol/paths.js";

interface CatalogFixture {
  catalog: WorkspaceRootCatalog;
  folders: vscode.WorkspaceFolder[];
  repositories: RepoInfo[];
  toplevels: Map<string, string | undefined>;
  repositoryChanges: vscode.EventEmitter<void>;
  workspaceChanges: vscode.EventEmitter<vscode.WorkspaceFoldersChangeEvent>;
}

function workspaceFolder(root: string, name: string, index: number): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(root), name, index };
}

function createFixture(): CatalogFixture {
  const state = {
    folders: [] as vscode.WorkspaceFolder[],
    repositories: [] as RepoInfo[],
    toplevels: new Map<string, string | undefined>(),
  };
  const repositoryChanges = new vscode.EventEmitter<void>();
  const workspaceChanges = new vscode.EventEmitter<vscode.WorkspaceFoldersChangeEvent>();
  const source = {
    get repositories(): RepoInfo[] {
      return state.repositories;
    },
    onDidChangeRepositories: repositoryChanges.event,
  };
  const environment: WorkspaceRootCatalogEnvironment = {
    workspaceFolders: () => state.folders,
    onDidChangeWorkspaceFolders: workspaceChanges.event,
    gitToplevel: async (cwd) => state.toplevels.get(cwd),
  };
  const fixture: CatalogFixture = {
    catalog: new WorkspaceRootCatalog(source, environment),
    folders: state.folders,
    repositories: state.repositories,
    toplevels: state.toplevels,
    repositoryChanges,
    workspaceChanges,
  };
  return fixture;
}

suite("WorkspaceRootCatalog", () => {
  const disposables: vscode.Disposable[] = [];

  teardown(() => {
    while (disposables.length > 0) {
      disposables.pop()?.dispose();
    }
  });

  test("inventories roots using each repository's ending directory name", async () => {
    const fixture = createFixture();
    disposables.push(fixture.catalog, fixture.repositoryChanges, fixture.workspaceChanges);
    fixture.folders.push(
      workspaceFolder("/workspace/api", "api", 0),
      workspaceFolder("/workspace/docs", "docs", 1),
    );
    fixture.repositories.push(
      { uri: vscode.Uri.file("/workspace/api") },
      { uri: vscode.Uri.file("/workspace/api/vendor/nested") },
      { uri: vscode.Uri.file("/workspace/api/not-a-root") },
    );
    fixture.toplevels.set("/workspace/api", "/workspace/api");
    fixture.toplevels.set("/workspace/docs", undefined);
    fixture.toplevels.set("/workspace/api/vendor/nested", "/workspace/api/vendor/nested");
    fixture.toplevels.set("/workspace/api/not-a-root", "/workspace/api");

    await fixture.catalog.init();

    assert.deepStrictEqual(fixture.catalog.gitRoots, [
      { repoRoot: "/workspace/api", displayName: "api", workspaceIndex: 0 },
      {
        repoRoot: "/workspace/api/vendor/nested",
        displayName: "nested",
        workspaceIndex: 0,
      },
    ]);
    assert.deepStrictEqual(fixture.catalog.agentRoots, [
      "/workspace/api",
      "/workspace/api/vendor/nested",
      "/workspace/docs",
    ]);
  });

  test("rejects a false ancestor repo while retaining a verified nested repo", async () => {
    const fixture = createFixture();
    disposables.push(fixture.catalog, fixture.repositoryChanges, fixture.workspaceChanges);
    fixture.folders.push(workspaceFolder("/worktrees/feature", "feature", 0));
    fixture.repositories.push(
      { uri: vscode.Uri.file("/main/repo") },
      { uri: vscode.Uri.file("/worktrees/feature/packages/nested") },
    );
    fixture.toplevels.set("/worktrees/feature", "/worktrees/feature");
    fixture.toplevels.set("/main/repo", "/main/repo");
    fixture.toplevels.set(
      "/worktrees/feature/packages/nested",
      "/worktrees/feature/packages/nested",
    );

    await fixture.catalog.init();

    assert.deepStrictEqual(
      fixture.catalog.gitRoots.map((root) => root.repoRoot),
      ["/worktrees/feature", "/worktrees/feature/packages/nested"],
    );
  });

  test("deduplicates a shared repo under the earliest workspace folder", async () => {
    const fixture = createFixture();
    disposables.push(fixture.catalog, fixture.repositoryChanges, fixture.workspaceChanges);
    fixture.folders.push(
      workspaceFolder("/repo/packages/a", "a", 0),
      workspaceFolder("/repo/packages/b", "b", 1),
    );
    fixture.repositories.push({ uri: vscode.Uri.file("/repo") });
    fixture.toplevels.set("/repo/packages/a", "/repo");
    fixture.toplevels.set("/repo/packages/b", "/repo");
    fixture.toplevels.set("/repo", "/repo");

    await fixture.catalog.init();

    assert.deepStrictEqual(fixture.catalog.gitRoots, [
      { repoRoot: "/repo", displayName: "repo", workspaceIndex: 0 },
    ]);
    assert.deepStrictEqual(fixture.catalog.agentRoots, [
      "/repo",
      "/repo/packages/a",
      "/repo/packages/b",
    ]);
  });

  test("gitRootForPath selects the longest containing repository", async () => {
    const fixture = createFixture();
    disposables.push(fixture.catalog, fixture.repositoryChanges, fixture.workspaceChanges);
    fixture.folders.push(workspaceFolder("/workspace", "workspace", 0));
    fixture.repositories.push({ uri: vscode.Uri.file("/workspace/nested") });
    fixture.toplevels.set("/workspace", "/workspace");
    fixture.toplevels.set("/workspace/nested", "/workspace/nested");
    await fixture.catalog.init();

    assert.strictEqual(
      fixture.catalog.gitRootForPath("/workspace/nested/src/index.ts")?.repoRoot,
      "/workspace/nested",
    );
    assert.strictEqual(
      fixture.catalog.gitRootForPath("/workspace/src/index.ts")?.repoRoot,
      "/workspace",
    );
    assert.strictEqual(fixture.catalog.gitRootForPath("/elsewhere/file.ts"), undefined);
  });

  test("topology events refresh once and unchanged snapshots stay silent", async () => {
    const fixture = createFixture();
    disposables.push(fixture.catalog, fixture.repositoryChanges, fixture.workspaceChanges);
    const first = workspaceFolder("/one", "one", 0);
    fixture.folders.push(first);
    fixture.toplevels.set("/one", undefined);
    let changes = 0;
    disposables.push(fixture.catalog.onDidChange(() => changes++));
    await fixture.catalog.init();
    assert.strictEqual(changes, 1);

    await fixture.catalog.refresh();
    assert.strictEqual(changes, 1, "an identical snapshot must not emit");

    const second = workspaceFolder("/two", "two", 1);
    fixture.folders.push(second);
    fixture.toplevels.set("/two", undefined);
    const refreshed = new Promise<void>((resolve) => {
      const subscription = fixture.catalog.onDidChange(() => {
        subscription.dispose();
        resolve();
      });
    });
    fixture.workspaceChanges.fire({ added: [second], removed: [] });
    await refreshed;

    assert.strictEqual(changes, 2);
    assert.deepStrictEqual(fixture.catalog.agentRoots, ["/one", "/two"]);

    fixture.repositories.push({ uri: vscode.Uri.file("/two/nested") });
    fixture.toplevels.set("/two/nested", "/two/nested");
    const repositoryRefreshed = new Promise<void>((resolve) => {
      const subscription = fixture.catalog.onDidChange(() => {
        subscription.dispose();
        resolve();
      });
    });
    fixture.repositoryChanges.fire();
    await repositoryRefreshed;

    assert.strictEqual(changes, 3);
    assert.deepStrictEqual(
      fixture.catalog.gitRoots.map((root) => root.repoRoot),
      ["/two/nested"],
    );
  });

  test("a stale slow refresh cannot overwrite a newer root snapshot", async () => {
    let resolveSlow: ((root: string | undefined) => void) | undefined;
    const slow = new Promise<string | undefined>((resolve) => {
      resolveSlow = resolve;
    });
    const folders = [workspaceFolder("/slow", "slow", 0)];
    const repositoryChanges = new vscode.EventEmitter<void>();
    const workspaceChanges = new vscode.EventEmitter<vscode.WorkspaceFoldersChangeEvent>();
    const catalog = new WorkspaceRootCatalog(
      { repositories: [], onDidChangeRepositories: repositoryChanges.event },
      {
        workspaceFolders: () => folders,
        onDidChangeWorkspaceFolders: workspaceChanges.event,
        gitToplevel: (cwd) => (cwd === "/slow" ? slow : Promise.resolve(cwd)),
      },
    );
    disposables.push(catalog, repositoryChanges, workspaceChanges);

    const staleRefresh = catalog.refresh();
    await Promise.resolve();
    folders.splice(0, 1, workspaceFolder("/fast", "fast", 0));
    await catalog.refresh();
    resolveSlow?.("/slow");
    await staleRefresh;

    assert.deepStrictEqual(catalog.gitRoots, [
      { repoRoot: "/fast", displayName: "fast", workspaceIndex: 0 },
    ]);
    assert.deepStrictEqual(catalog.agentRoots, ["/fast"]);
  });
});

suite("repoRelativePath (canonicalization skew)", () => {
  test("a symlinked target path still resolves repo-relative (no ../ traversal)", () => {
    // Catalog roots are canonical (realpath'd), but VS Code reports raw fsPaths — on macOS the
    // tmpdir itself is a symlink (/var -> /private/var), so relative(canonicalRoot, rawPath)
    // walks out of the root. Reproduce with an explicit symlink so the test bites on any OS.
    const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pai-real-"));
    const link = path.join(fs.realpathSync(os.tmpdir()), `pai-link-${path.basename(real)}`);
    fs.symlinkSync(real, link);
    try {
      // The commented file always exists (it's a changed working-tree file) — and canonicalize only
      // resolves symlinks for paths that exist, so the fixture must too.
      fs.writeFileSync(path.join(real, "hello.txt"), "hi");
      fs.mkdirSync(path.join(real, "a"));
      fs.writeFileSync(path.join(real, "a", "b.txt"), "b");
      const canonicalRoot = canonicalize(real);
      const viaSymlink = path.join(link, "hello.txt");
      assert.strictEqual(repoRelativePath(canonicalRoot, viaSymlink), "hello.txt");
      // Plain files keep working too.
      assert.strictEqual(repoRelativePath(canonicalRoot, path.join(real, "a", "b.txt")), path.join("a", "b.txt"));
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});
