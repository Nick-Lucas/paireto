import * as assert from "node:assert";

import {
  appendFeedbackReply,
  editFeedback,
  markFeedbackSent,
  pendingFeedback,
  resolveFeedback,
} from "../review/feedbackState.js";
import { userFeedback, type ReviewThread } from "../review/reviewTypes.js";

suite("feedback lifecycle", () => {
  const item = (over: Partial<ReviewThread> = {}): ReviewThread => ({
    id: "feedback-1",
    repoRoot: "/repo",
    filePath: "src/a.ts",
    side: "modified",
    line: 0,
    anchor: { lineText: "complex();", contextBefore: [], contextAfter: [], lineHash: "hash" },
    delivery: "pending",
    createdAt: "2026-08-12T20:00:00.000Z",
    updatedAt: "2026-08-12T20:00:00.000Z",
    activities: [
      {
        kind: "feedback",
        feedbackKind: "comment",
        body: "Please simplify this.",
        quote: "complex();",
        at: "2026-08-12T20:00:00.000Z",
      },
    ],
    ...over,
  });

  test("sends only pending items and keeps sent history", () => {
    const pending = item({ id: "pending" });
    const sent = item({ id: "sent", delivery: "sent" });
    assert.deepStrictEqual(
      pendingFeedback([sent, pending]).map((entry) => entry.id),
      ["pending"],
    );
    assert.deepStrictEqual(markFeedbackSent([sent, pending], "2026-08-12T20:01:00.000Z"), [
      sent,
      { ...pending, delivery: "sent", updatedAt: "2026-08-12T20:01:00.000Z" },
    ]);
  });

  test("editing sent or resolved feedback makes it pending and unresolved", () => {
    const edited = editFeedback(
      item({ delivery: "sent", resolvedAt: "2026-08-12T20:02:00.000Z" }),
      "Please simplify both branches.",
      "2026-08-12T20:03:00.000Z",
    );
    assert.strictEqual(edited.delivery, "pending");
    assert.strictEqual(edited.resolvedAt, undefined);
    assert.strictEqual(userFeedback(edited).body, "Please simplify both branches.");
  });

  test("reply adds activity without resolving", () => {
    const replied = appendFeedbackReply(item({ delivery: "sent" }), {
      body: "I replaced it with a direct return.",
      at: "2026-08-12T20:04:00.000Z",
      harness: "claudecode",
      sessionId: "session-1",
    });
    assert.strictEqual(replied.resolvedAt, undefined);
    assert.deepStrictEqual(replied.activities, [
      userFeedback(replied),
      {
        kind: "reply",
        body: "I replaced it with a direct return.",
        at: "2026-08-12T20:04:00.000Z",
        harness: "claudecode",
        sessionId: "session-1",
      },
    ]);
  });

  test("resolve is idempotent", () => {
    const first = resolveFeedback(item({ delivery: "sent" }), {
      at: "2026-08-12T20:05:00.000Z",
      harness: "codex",
    });
    const second = resolveFeedback(first, {
      at: "2026-08-12T20:06:00.000Z",
      harness: "codex",
    });
    assert.strictEqual(second, first);
    assert.strictEqual(first.resolvedAt, "2026-08-12T20:05:00.000Z");
    assert.strictEqual(
      first.activities.filter((activity) => activity.kind === "resolved").length,
      1,
    );
  });
});
