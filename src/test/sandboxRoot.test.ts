// The agent, the extension and git all have to mean the same directory. git and the harnesses resolve
// symlinks, so the sandbox hands out an already-resolved path: on macOS /tmp is a symlink to
// /private/tmp, and an unresolved root makes the agent's cwd disagree with the repo root the
// extension computes — a shape no user's session has.

import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildClaudeHome,
  buildCodexHome,
  buildOpenCodeHome,
  createSandbox,
  mockPath,
  mockTmpRoot,
} from "../e2e/sandbox.js";

suite("E2E sandbox root", () => {
  test("hands out a symlink-resolved repo root", () => {
    const sandbox = createSandbox();
    try {
      assert.strictEqual(sandbox.repoRoot, fs.realpathSync(sandbox.repoRoot));
    } finally {
      sandbox.cleanup();
    }
  });

  // An agent that runs `git log` puts the commit id in its next request body, so a sandbox whose
  // initial commit hashed differently each run could never replay: the recorded id would never
  // reappear. The tree and the identity are already fixed, so the dates are what remains — pinned
  // here as literals, because a change to them invalidates every cassette holding the old id.
  test("the initial commit is dated from a fixed point, so its id never moves", () => {
    const sandbox = createSandbox();
    try {
      const show = (format: string): string =>
        execFileSync("git", ["log", "-1", `--format=${format}`], { cwd: sandbox.repoRoot })
          .toString()
          .trim();
      assert.strictEqual(show("%aI"), "2020-01-01T00:00:00+00:00", "author date");
      assert.strictEqual(show("%cI"), "2020-01-01T00:00:00+00:00", "committer date");
    } finally {
      sandbox.cleanup();
    }
  });

  test("resolves a fixed mock-mode root too", () => {
    const sandbox = createSandbox({
      fixedRepoRoot: mockPath("paireto-e2e-sandbox-root-test"),
    });
    try {
      assert.strictEqual(sandbox.repoRoot, fs.realpathSync(sandbox.repoRoot));
      assert.ok(sandbox.repoRoot.endsWith("paireto-e2e-sandbox-root-test"));
    } finally {
      sandbox.cleanup();
    }
  });
});

suite("mock-run tmp root", () => {
  test("is canonical, so the same directory is spelled one way on every platform", () => {
    const root = mockTmpRoot();
    assert.strictEqual(fs.realpathSync(root), root);
  });

  test("prefers /private/tmp, which macOS and Linux both resolve to itself", () => {
    // Falling back to /tmp is allowed where /private cannot be created, but then a cassette recorded
    // elsewhere will not replay — so record and check must happen in the same place.
    assert.ok(["/private/tmp", "/tmp"].includes(mockTmpRoot()));
  });

  test("builds fixed paths under that root", () => {
    assert.strictEqual(mockPath("pai-e2e-claude-home"), `${mockTmpRoot()}/pai-e2e-claude-home`);
  });

  test("rejects names outside the owned mock-run namespace", () => {
    assert.throws(() => mockPath("x/../../../Users/example"), /mock-run namespace/i);
    assert.throws(() => mockPath("../outside"), /mock-run namespace/i);
    assert.throws(() => mockPath("/tmp/outside"), /mock-run namespace/i);
    assert.throws(() => mockPath("paireto-e2e-unknown"), /mock-run namespace/i);
  });

  test("refuses every fixed deletion target outside the owned mock-run namespace", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pai-fixed-path-guard-"));
    const marker = path.join(outside, "keep.txt");
    fs.writeFileSync(marker, "keep\n");
    try {
      assert.throws(() => createSandbox({ fixedRepoRoot: outside }), /mock-run namespace/i);
      for (const buildHome of [buildClaudeHome, buildCodexHome, buildOpenCodeHome]) {
        assert.throws(() => buildHome({ homeDir: outside }), /mock-run namespace/i);
      }
      assert.strictEqual(fs.readFileSync(marker, "utf8"), "keep\n");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
