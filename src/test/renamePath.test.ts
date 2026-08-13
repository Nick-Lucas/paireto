// Unit tests for the rename input box's pure path resolution (no vscode).

import * as assert from "node:assert";

import { resolveRenameTarget } from "../review/renamePath.js";

/** The resolved path, or the assertion fails with the rejection message. */
function resolved(currentPath: string, input: string): string {
  const target = resolveRenameTarget(currentPath, input);
  assert.ok(target.ok, `expected ok, got: ${target.ok ? "" : target.message}`);
  return target.path;
}

/** The rejection message, or the assertion fails with the resolved path. */
function rejected(currentPath: string, input: string): string {
  const target = resolveRenameTarget(currentPath, input);
  assert.ok(!target.ok, `expected a rejection, got: ${target.ok ? target.path : ""}`);
  return target.message;
}

suite("resolveRenameTarget", () => {
  test("a bare name stays in the file's own folder", () => {
    assert.strictEqual(resolved("src/a.ts", "b.ts"), "src/b.ts");
    assert.strictEqual(resolved("a.ts", "b.ts"), "b.ts");
  });

  test("a path with / moves the file", () => {
    assert.strictEqual(resolved("src/a.ts", "git/b.ts"), "src/git/b.ts");
    assert.strictEqual(resolved("src/a.ts", "./git/b.ts"), "src/git/b.ts");
  });

  test("../ resolves up one folder", () => {
    assert.strictEqual(resolved("src/a.ts", "../b.ts"), "b.ts");
    assert.strictEqual(resolved("src/git/a.ts", "../b.ts"), "src/b.ts");
  });

  test("a backslash reads as a folder separator", () => {
    assert.strictEqual(resolved("src/a.ts", "git\\b.ts"), "src/git/b.ts");
  });

  test("an unchanged name resolves ok, so the input box shows no error", () => {
    assert.strictEqual(resolved("src/a.ts", "a.ts"), "src/a.ts");
  });

  test("rejects an empty name", () => {
    assert.strictEqual(rejected("src/a.ts", ""), "Type a file name.");
    assert.strictEqual(rejected("src/a.ts", "   "), "Type a file name.");
  });

  test("rejects a trailing / — that names a folder, not a file", () => {
    assert.strictEqual(rejected("src/a.ts", "git/"), "Type a file name.");
    assert.strictEqual(rejected("src/a.ts", ".."), "Type a file name.");
  });

  test("rejects an empty folder name", () => {
    assert.strictEqual(rejected("src/a.ts", "git//b.ts"), "Remove the empty folder name.");
  });

  test("rejects an absolute path", () => {
    const message = "Type a name or a path inside the repository.";
    assert.strictEqual(rejected("src/a.ts", "/tmp/b.ts"), message);
    assert.strictEqual(rejected("src/a.ts", "C:\\tmp\\b.ts"), message);
  });

  test("rejects a path that leaves the repository root", () => {
    assert.strictEqual(
      rejected("src/a.ts", "../../out.ts"),
      "The new path must stay inside the repository.",
    );
    assert.strictEqual(
      rejected("a.ts", "../out.ts"),
      "The new path must stay inside the repository.",
    );
  });

  test("rejects a character that no filesystem accepts, naming it", () => {
    // Rejected on every platform: a name that only works on macOS breaks the repository for everyone.
    for (const char of ["<", ">", ":", '"', "|", "?", "*"]) {
      assert.strictEqual(
        rejected("src/a.ts", `b${char}.ts`),
        `The character ${char} cannot be used in a file name.`,
      );
    }
  });

  test("rejects a control character", () => {
    assert.strictEqual(
      rejected("src/a.ts", "b\u0007.ts"),
      "The character \u0007 cannot be used in a file name.",
    );
  });
});
