// The agent, the extension and git all have to mean the same directory. git and the harnesses resolve
// symlinks, so the sandbox hands out an already-resolved path: on macOS /tmp is a symlink to
// /private/tmp, and an unresolved root makes the agent's cwd disagree with the repo root the
// extension computes — a shape no user's session has.

import * as assert from "node:assert";
import * as fs from "node:fs";

import { createSandbox, mockPath, mockTmpRoot } from "../e2e/sandbox.js";

suite("E2E sandbox root", () => {
  test("hands out a symlink-resolved repo root", () => {
    const sandbox = createSandbox();
    try {
      assert.strictEqual(sandbox.repoRoot, fs.realpathSync(sandbox.repoRoot));
    } finally {
      sandbox.cleanup();
    }
  });

  test("resolves a fixed mock-mode root too", () => {
    const sandbox = createSandbox({ fixedRepoRoot: "/tmp/paireto-sandbox-root-test" });
    try {
      assert.strictEqual(sandbox.repoRoot, fs.realpathSync(sandbox.repoRoot));
      assert.ok(sandbox.repoRoot.endsWith("paireto-sandbox-root-test"));
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
});
