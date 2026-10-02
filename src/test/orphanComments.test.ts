import * as assert from "node:assert";

import {
  fileKey,
  orphanCandidates,
  orphanedComments,
  orphanedFiles,
} from "../review/orphanComments.js";
import type { ReviewThread } from "../review/reviewTypes.js";

suite("orphaned comment selection", () => {
  const thread = (over: Partial<ReviewThread> = {}): ReviewThread => ({
    id: "feedback-1",
    repoRoot: "/repo",
    filePath: "src/a.ts",
    side: "modified",
    line: 0,
    anchor: { lineText: "one();", contextBefore: [], contextAfter: [], lineHash: "hash" },
    delivery: "pending",
    createdAt: "2026-09-14T09:00:00.000Z",
    updatedAt: "2026-09-14T09:00:00.000Z",
    items: [
      {
        kind: "comment",
        commentKind: "comment",
        body: "Please look at this.",
        quote: "one();",
        at: "2026-09-14T09:00:00.000Z",
      },
    ],
    ...over,
  });

  const scanned = (repoRoot: string): boolean => repoRoot === "/repo";
  const nothingChanged = (): boolean => false;

  test("a comment on a file git still reports is never a candidate", () => {
    const changed = (repoRoot: string, filePath: string): boolean =>
      repoRoot === "/repo" && filePath === "src/a.ts";
    assert.deepStrictEqual(orphanCandidates([thread()], scanned, changed), []);
  });

  test("a comment in a repository with no live scan is left alone", () => {
    assert.deepStrictEqual(
      orphanCandidates([thread()], () => false, nothingChanged),
      [],
    );
  });

  test("a changeset comment has no file, so it is never a candidate", () => {
    const description = thread({
      id: "feedback-2",
      filePath: "",
      changeset: { id: "cs-1", title: "Rename the port" },
      sourceDocument: { uri: "paireto-changeset://cs-1", markdown: "# Rename" },
    });
    assert.deepStrictEqual(orphanCandidates([description], scanned, nothingChanged), []);
  });

  test("a comment whose file git dropped is a candidate", () => {
    assert.deepStrictEqual(
      orphanCandidates([thread()], scanned, nothingChanged).map((item) => item.id),
      ["feedback-1"],
    );
  });

  test("each candidate file is probed one time", () => {
    const candidates = [
      thread(),
      thread({ id: "feedback-2" }),
      thread({ id: "feedback-3", filePath: "src/b.ts" }),
    ];
    assert.deepStrictEqual(orphanedFiles(candidates), [
      { repoRoot: "/repo", filePath: "src/a.ts" },
      { repoRoot: "/repo", filePath: "src/b.ts" },
    ]);
  });

  test("only the candidates whose file is off the disk are removed", () => {
    const candidates = [thread(), thread({ id: "feedback-2", filePath: "src/b.ts" })];
    const present = new Set([fileKey("/repo", "src/b.ts")]);
    assert.deepStrictEqual(
      orphanedComments(candidates, present).map((thread) => thread.id),
      ["feedback-1"],
    );
  });
});
