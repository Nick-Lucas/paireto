import * as assert from "node:assert";

import * as vscode from "vscode";

import type { DeltaFile } from "../review/delta.js";
import { SeenFiles } from "../review/SeenFiles.js";
import { RESET_REVIEW, resetReview } from "../uml/resetReview.js";

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
  get<T>(key: string, fallback?: T): T {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

function file(path: string): DeltaFile {
  return {
    repoRoot: "/repo",
    path,
    status: "M",
    additions: 1,
    deletions: 0,
    contentId: `blob:${path}`,
    stage: "unstaged",
    layers: [],
  };
}

suite("UML diff — reset the review", () => {
  test("after you confirm, every file in the comparison is not seen again", async () => {
    const seen = new SeenFiles(new MemoryMemento());
    const files = [file("src/a.ts"), file("src/b.ts"), file("src/c.ts")];
    await seen.setSeen(files.slice(0, 2), true);
    const asked: string[] = [];

    const reset = await resetReview(seen, files, (message, action) => {
      asked.push(message);
      return Promise.resolve(action);
    });

    assert.strictEqual(reset, true);
    assert.strictEqual(asked.length, 1);
    assert.ok(asked[0].includes("2 of 3"), asked[0]);
    assert.deepStrictEqual(
      files.map((f) => seen.isSeen(f)),
      [false, false, false],
    );
  });

  test("when you cancel, the seen files stay seen", async () => {
    const seen = new SeenFiles(new MemoryMemento());
    const files = [file("src/a.ts"), file("src/b.ts")];
    await seen.setSeen(files, true);

    const reset = await resetReview(seen, files, () => Promise.resolve(undefined));

    assert.strictEqual(reset, false);
    assert.deepStrictEqual(
      files.map((f) => seen.isSeen(f)),
      [true, true],
    );
  });

  test("when no file is seen, nothing is asked and nothing changes", async () => {
    const seen = new SeenFiles(new MemoryMemento());
    let asked = false;

    const reset = await resetReview(seen, [file("src/a.ts")], () => {
      asked = true;
      return Promise.resolve(RESET_REVIEW);
    });

    assert.strictEqual(reset, false);
    assert.strictEqual(asked, false);
  });
});
