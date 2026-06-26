// Guards that the review content provider serves arbitrary file bytes verbatim (images, etc.), not a
// UTF-8 round-trip that mangles non-text bytes. The Changes view diffs and "Open File" must support
// ANY file type VS Code can open, matching the native git panel.

import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { DiffService, singlePaneSide, type ChangedFile } from "../git/DiffService.js";
import { ReviewContentProvider } from "../review/ReviewContentProvider.js";

// A tiny 1x1 PNG: contains bytes (0x89, 0xFF, 0x00) that are not valid standalone UTF-8 and so are
// destroyed by a read-as-utf8 → re-encode-as-utf8 round trip.
const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4" +
    "890000000d4944415478da6364f8cf000001010100b537a47b0000000049454e44ae426082",
  "hex",
);

suite("binary diff content", () => {
  let dir: string;
  let provider: ReviewContentProvider;

  suiteSetup(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "paireto-bin-"));
    await fs.writeFile(path.join(dir, "pixel.png"), PNG_1x1);
    provider = new ReviewContentProvider();
  });

  suiteTeardown(async () => {
    provider.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("readFile returns the working-tree file's exact bytes", async () => {
    const uri = ReviewContentProvider.buildUri("rev1", "modified", "pixel.png", "WORKING", dir);
    const bytes = await provider.readFile(uri);
    assert.deepStrictEqual(Buffer.from(bytes), PNG_1x1, "binary bytes must round-trip unchanged");
  });

  test("stat reports the true byte length, not the utf8 re-encoding length", async () => {
    const uri = ReviewContentProvider.buildUri("rev1", "modified", "pixel.png", "WORKING", dir);
    const stat = await provider.stat(uri);
    assert.strictEqual(stat.size, PNG_1x1.length);
  });
});

// Adds/deletes have an empty side, so they must open a SINGLE editor (like the git panel) rather than
// a two-pane diff with a broken/empty pane — an image viewer can't render the empty side at all.
suite("single-pane add/delete", () => {
  const diff = new DiffService();
  const file = (group: ChangedFile["group"], status: ChangedFile["status"]): ChangedFile => ({
    path: "img.png",
    group,
    status,
    additions: 0,
    deletions: 0,
  });

  test("a real modification keeps the two-pane diff", () => {
    assert.strictEqual(singlePaneSide(diff.fileSides(file("unstaged", "M"), null)), null);
  });

  test("an added (untracked) file shows only the modified side", () => {
    assert.strictEqual(singlePaneSide(diff.fileSides(file("unstaged", "U"), null)), "modified");
  });

  test("a staged-new file shows only the modified side", () => {
    assert.strictEqual(singlePaneSide(diff.fileSides(file("staged", "A"), null)), "modified");
  });

  test("a deleted file shows only the base side", () => {
    assert.strictEqual(singlePaneSide(diff.fileSides(file("unstaged", "D"), null)), "base");
  });
});
