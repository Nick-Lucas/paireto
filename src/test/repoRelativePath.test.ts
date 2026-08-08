// Review feedback names each comment by `file:line`, so the path an agent receives has to be
// repo-relative. A git-resolved repo root is symlink-free while an editor URI keeps whatever path the
// workspace was opened with; subtracting one from the other raw escapes the repo on macOS, where
// /tmp is a symlink to /private/tmp.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { repoRelativePath } from "../protocol/paths.js";

suite("repo-relative path", () => {
  test("subtracts the repo root", () => {
    assert.strictEqual(
      repoRelativePath("/repo", "/repo/src/index.ts"),
      path.join("src", "index.ts"),
    );
  });

  test("stays repo-relative when only one side is canonical", function () {
    // Needs a real symlink to reproduce; /private/tmp is macOS's, so build one anywhere.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "paireto-symlink-"));
    const real = path.join(base, "real-repo");
    const link = path.join(base, "linked-repo");
    fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, link, "dir");
    } catch {
      this.skip(); // no symlink permission (Windows without developer mode)
      return;
    }
    try {
      fs.writeFileSync(path.join(real, "hello.txt"), "hi");

      // The git-resolved root is the real path; the editor URI came through the symlink.
      const rel = repoRelativePath(real, path.join(link, "hello.txt"));

      assert.strictEqual(rel, "hello.txt");
      assert.ok(!rel.startsWith(".."), `escaped the repo: ${rel}`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("a file genuinely outside the repo still reports as outside", () => {
    assert.ok(repoRelativePath("/repo", "/elsewhere/file.ts").startsWith(".."));
  });
});
