import * as assert from "node:assert";

import { BOX } from "../viz/layout/classBox.js";
import type { Rect } from "../viz/layout/geometry.js";
import { estimateMeasure } from "../viz/layout/measure.js";
import { layoutSequence, sequenceSpotAt } from "../viz/layout/sequence.js";
import {
  DEFAULT_OVERVIEW_OPTIONS,
  layoutOverview,
  type OverviewScene,
} from "../viz/layout/overview.js";
import {
  commentedMembers,
  diagramNotes,
  edgeTarget,
  memberTarget,
  noteStatus,
  overviewBubbles,
  sequenceBubbles,
  STEP_BUBBLE_GAP,
  stepTarget,
  targetKey,
  targetRect,
  targetsTitle,
  timeAgo,
} from "../viz/model/notes.js";
import type { VizNote } from "../viz/protocol.js";
import { makeElk } from "./vizElk.js";
import { classDiagramIndex } from "./vizFixtures.js";

const index = classDiagramIndex();
const EMAIL = "src/notify/emailChannel.ts#EmailChannel";
const NODE = { kind: "node", id: EMAIL, label: "EmailChannel" } as const;
const NOTIFIER_NODE = {
  kind: "node",
  id: "src/notify/notifier.ts#Notifier",
  label: "Notifier",
} as const;

function note(id: string, extra: Partial<VizNote> = {}): VizNote {
  return {
    id,
    kind: "comment",
    title: id,
    body: "Put the delta lookups in one place so they cannot drift apart.",
    items: [{ id, who: "you", body: "x", at: "2026-01-01T00:00:00Z", sent: false }],
    sent: false,
    unread: 0,
    waiting: false,
    resolved: false,
    targets: [{ kind: "node", id: EMAIL, label: "EmailChannel" }],
    ...extra,
  };
}

function scene(): Promise<OverviewScene> {
  return layoutOverview(index, makeElk(), {
    ...DEFAULT_OVERVIEW_OPTIONS,
    measure: estimateMeasure,
  });
}

function nodeRect(placed: OverviewScene, id: string): Rect {
  const found = placed.nodes.find((candidate) => candidate.id === id);
  assert.ok(found);
  return found;
}

suite("viz notes", () => {
  test("each target gets one bubble with its open notes, and a member keeps its own", async () => {
    const laid = await scene();
    const send = memberTarget(index, `${EMAIL}.send`);
    const edge = edgeTarget(index, index.edges[0].id);
    assert.ok(send && edge);
    const bubbles = overviewBubbles(
      laid,
      index,
      [
        note("a"),
        note("b", { targets: [NODE, NOTIFIER_NODE] }),
        note("m", { targets: [send] }),
        note("e", { targets: [edge] }),
        note("gone", { resolved: true }),
        note("free", { targets: [] }),
        note("step", { targets: [stepTarget(index, "deliver", 2)!] }),
      ],
      [],
    );
    assert.deepStrictEqual(
      bubbles.map((bubble) => [bubble.target.label, bubble.notes.map((found) => found.id)]),
      [
        ["EmailChannel", ["a", "b"]],
        ["Notifier", ["b"]],
        ["EmailChannel.send", ["m"]],
        [edge.label, ["e"]],
      ],
    );
    const home = nodeRect(laid, EMAIL);
    assert.deepStrictEqual(bubbles[0].at, { x: home.x + home.width, y: home.y });
    const row = targetRect(laid, index, send);
    assert.ok(row);
    assert.strictEqual(row.height, BOX.rowHeight);
    assert.deepStrictEqual(bubbles[2].at, { x: row.x + row.width, y: row.y + row.height / 2 });
    const label = targetRect(laid, index, edge);
    assert.ok(label);
    assert.deepStrictEqual(bubbles[3].at, { x: label.x + label.width, y: label.y });
    assert.strictEqual(bubbles[0].key, targetKey(NODE));
  });

  test("a selected or drafted target with no notes gets one empty bubble", async () => {
    const bubbles = overviewBubbles(
      await scene(),
      index,
      [note("a")],
      [NOTIFIER_NODE, NODE, NOTIFIER_NODE],
    );
    assert.deepStrictEqual(
      bubbles.map((bubble) => [bubble.target.label, bubble.notes.length]),
      [
        ["EmailChannel", 1],
        ["Notifier", 0],
      ],
    );
  });

  test("members with open notes are the ones a folded box keeps", () => {
    const send = memberTarget(index, `${EMAIL}.send`);
    const retries = memberTarget(index, `${EMAIL}.retries`);
    assert.ok(send && retries);
    assert.deepStrictEqual(
      [
        ...commentedMembers([
          note("a"),
          note("m", { targets: [send] }),
          note("old", { targets: [retries], resolved: true }),
        ]),
      ],
      [`${EMAIL}.send`],
    );
  });

  test("notes with no target are about the whole diagram", () => {
    assert.deepStrictEqual(
      diagramNotes([
        note("a"),
        note("free", { targets: [] }),
        note("old", { targets: [], resolved: true }),
      ]).map((found) => found.id),
      ["free"],
    );
    assert.strictEqual(targetsTitle([]), "the whole diagram");
  });

  test("a note's status line reads replies, sending and unread counts", () => {
    assert.deepStrictEqual(noteStatus(note("a")), { meta: "not sent", badge: "" });
    assert.deepStrictEqual(noteStatus(note("b", { sent: true, waiting: true })), {
      meta: "sent · waiting",
      badge: "",
    });
    const reply = {
      id: "r",
      who: "agent" as const,
      body: "y",
      at: "2026-01-01T00:01:00Z",
      sent: true,
    };
    assert.deepStrictEqual(
      noteStatus(note("c", { sent: true, unread: 2, items: [...note("c").items, reply, reply] })),
      { meta: "sent", badge: "2 new replies" },
    );
    assert.deepStrictEqual(noteStatus(note("d", { items: [...note("d").items, reply] })), {
      meta: "1 reply · not sent",
      badge: "",
    });
  });

  test("times read as minutes, hours and days ago", () => {
    const now = Date.parse("2026-01-02T12:00:00Z");
    assert.strictEqual(timeAgo("2026-01-02T11:59:40Z", now), "just now");
    assert.strictEqual(timeAgo("2026-01-02T11:18:00Z", now), "42 min ago");
    assert.strictEqual(timeAgo("2026-01-02T11:00:00Z", now), "1 hour ago");
    assert.strictEqual(timeAgo("2025-12-30T12:00:00Z", now), "3 days ago");
  });
});

suite("viz notes on a sequence diagram", () => {
  const NOTIFIER = "src/notify/notifier.ts#Notifier";
  const seq = layoutSequence(index, "deliver");
  const STEP = stepTarget(index, "deliver", 2)!;

  test("a step target names its flow, its number and its message", () => {
    assert.deepStrictEqual(STEP, {
      kind: "step",
      flow: "deliver",
      index: 2,
      label: "Deliver with fallback, step 3: send(message)",
    });
    assert.strictEqual(stepTarget(index, "deliver", 99), undefined);
  });

  test("on a sequence diagram parts and steps get bubbles, and members and edges stay off", () => {
    const send = memberTarget(index, `${EMAIL}.send`);
    const edge = edgeTarget(index, index.edges[0].id);
    assert.ok(send && edge);
    const bubbles = sequenceBubbles(
      seq,
      index,
      [
        note("p"),
        note("s", { targets: [STEP] }),
        note("m", { targets: [send] }),
        note("e", { targets: [edge] }),
      ],
      [],
    );
    assert.deepStrictEqual(
      bubbles.map((bubble) => [bubble.target.label, bubble.notes.map((found) => found.id)]),
      [
        ["EmailChannel", ["p"]],
        [STEP.label, ["s"]],
      ],
    );
    const head = seq.participants.find((candidate) => candidate.id === EMAIL)!;
    assert.deepStrictEqual(bubbles[0].at, { x: head.x + head.width, y: head.y });
    const message = seq.messages[2];
    assert.deepStrictEqual(bubbles[1].at, {
      x: message.x + message.width + STEP_BUBBLE_GAP,
      y: message.y,
    });
  });

  test("a right-click on a step's row picks the step, and on a lifeline past the rows its participant", () => {
    const row = seq.messages[1];
    const middle = seq.bounds.x + seq.bounds.width / 2;
    assert.deepStrictEqual(sequenceSpotAt(seq, { x: middle, y: row.lineY + 12 }), {
      kind: "step",
      index: 1,
    });
    const email = seq.participants.find((candidate) => candidate.id === EMAIL)!;
    assert.deepStrictEqual(
      sequenceSpotAt(seq, { x: email.lifelineX + 20, y: seq.lifelineBottom - 2 }),
      { kind: "participant", id: EMAIL },
    );
    assert.deepStrictEqual(
      sequenceSpotAt(seq, { x: email.lifelineX, y: email.y + email.height / 2 }),
      { kind: "participant", id: EMAIL },
    );
    assert.strictEqual(
      sequenceSpotAt(seq, { x: seq.bounds.x + seq.bounds.width + 200, y: row.lineY }),
      undefined,
    );
  });

  test("on the Overview a step target points at the part that sends the step", async () => {
    const placed = await scene();
    assert.deepStrictEqual(targetRect(placed, index, STEP), nodeRect(placed, NOTIFIER));
  });
});
