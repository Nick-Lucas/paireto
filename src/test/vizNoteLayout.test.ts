import * as assert from "node:assert";

import { BOX } from "../viz/layout/classBox.js";
import type { Rect } from "../viz/layout/geometry.js";
import { estimateMeasure } from "../viz/layout/measure.js";
import {
  DEFAULT_OVERVIEW_OPTIONS,
  layoutOverview,
  type OverviewScene,
} from "../viz/layout/overview.js";
import {
  allTargets,
  memberTarget,
  NOTE,
  noteStatus,
  placeNotes,
  relativePlace,
  searchTargets,
  targetRect,
  timeAgo,
} from "../viz/model/notes.js";
import type { VizNote, VizReviewFile } from "../viz/protocol.js";
import { makeElk } from "./vizElk.js";
import { classDiagramIndex } from "./vizFixtures.js";

const index = classDiagramIndex();
const EMAIL = "src/notify/emailChannel.ts#EmailChannel";
const FILES: VizReviewFile[] = ["channel.ts", "emailChannel.ts"].map((name) => ({
  repo: "shop",
  path: `src/notify/${name}`,
  status: "M",
  additions: 1,
  deletions: 1,
  seen: false,
}));

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

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function onBorder(rect: Rect, point: { x: number; y: number }): boolean {
  const inside =
    point.x >= rect.x - 0.5 &&
    point.x <= rect.x + rect.width + 0.5 &&
    point.y >= rect.y - 0.5 &&
    point.y <= rect.y + rect.height + 0.5;
  const onEdge =
    Math.abs(point.x - rect.x) < 0.5 ||
    Math.abs(point.x - rect.x - rect.width) < 0.5 ||
    Math.abs(point.y - rect.y) < 0.5 ||
    Math.abs(point.y - rect.y - rect.height) < 0.5;
  return inside && onEdge;
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
  test("a note with no place sits beside its target, clear of every box, with an arrow to its border", async () => {
    const laid = await scene();
    const placed = placeNotes(laid, index, [note("n1")], undefined, estimateMeasure);
    assert.strictEqual(placed.length, 1);
    const [sticky] = placed;
    assert.strictEqual(sticky.width, NOTE.width);
    for (const box of laid.nodes) {
      assert.ok(!overlaps(sticky, box), `note stays off ${box.id}`);
    }
    assert.strictEqual(sticky.links.length, 1);
    assert.ok(onBorder(nodeRect(laid, EMAIL), sticky.links[0].to));
    assert.ok(onBorder(sticky, sticky.links[0].from));
  });

  test("two notes on the same target do not cover each other", async () => {
    const placed = placeNotes(
      await scene(),
      index,
      [note("n1"), note("n2")],
      undefined,
      estimateMeasure,
    );
    assert.ok(!overlaps(placed[0], placed[1]));
  });

  test("a dragged place is kept relative to its home box", async () => {
    const laid = await scene();
    const placed = placeNotes(
      laid,
      index,
      [note("n1", { place: { node: EMAIL, x: -260, y: -40 } })],
      undefined,
      estimateMeasure,
    );
    const home = nodeRect(laid, EMAIL);
    assert.deepStrictEqual([placed[0].x, placed[0].y], [home.x - 260, home.y - 40]);
    assert.deepStrictEqual(relativePlace(laid, { x: home.x + home.width + 30, y: home.y + 5 }), {
      node: EMAIL,
      x: home.width + 30,
      y: 5,
    });
    const far = { x: laid.bounds.x - 2000, y: laid.bounds.y - 2000 };
    assert.deepStrictEqual(relativePlace(laid, far), far);
  });

  test("resolved notes leave the canvas and a draft gets its own sticky", async () => {
    const placed = placeNotes(
      await scene(),
      index,
      [note("gone", { resolved: true })],
      {
        kind: "question",
        targets: [{ kind: "node", id: EMAIL, label: "EmailChannel" }],
        place: undefined,
      },
      estimateMeasure,
    );
    assert.deepStrictEqual(
      placed.map((sticky) => [sticky.id, sticky.kind, sticky.note]),
      [["draft", "question", undefined]],
    );
  });

  test("a member target points at its own row", async () => {
    const laid = await scene();
    const target = memberTarget(index, `${EMAIL}.send`);
    assert.ok(target);
    assert.strictEqual(target.label, "EmailChannel.send");
    const rect = targetRect(laid, index, target);
    const home = nodeRect(laid, EMAIL);
    assert.ok(rect);
    assert.strictEqual(rect.height, BOX.rowHeight);
    assert.ok(rect.y > home.y && rect.y + rect.height < home.y + home.height);
  });

  test("a link to a member stops on the class box border beside that row", async () => {
    const laid = await scene();
    const target = memberTarget(index, `${EMAIL}.send`);
    assert.ok(target);
    const [sticky] = placeNotes(
      laid,
      index,
      [note("n1", { targets: [target], place: { node: EMAIL, x: 0, y: -160 } })],
      undefined,
      estimateMeasure,
    );
    const row = targetRect(laid, index, target);
    assert.ok(row);
    const { to } = sticky.links[0];
    assert.ok(
      onBorder(nodeRect(laid, EMAIL), to),
      `ends on the box border, not at ${to.x},${to.y}`,
    );
    assert.ok(to.y >= row.y && to.y <= row.y + row.height, "ends level with the row");
  });

  test("a note with no free spot beside its target goes to the nearest free spot", async () => {
    const laid = await scene();
    const home = nodeRect(laid, EMAIL);
    const height = placeNotes(laid, index, [note("probe")], undefined, estimateMeasure)[0].height;
    const spots = [
      { x: home.width + NOTE.gap, y: 0 },
      { x: -NOTE.gap - NOTE.width, y: 0 },
      { x: 0, y: -NOTE.gap - height },
      { x: 0, y: home.height + NOTE.gap },
    ];
    const blockers = spots.map((spot, at) =>
      note(`block${at}`, { place: { node: EMAIL, ...spot } }),
    );
    const far = note("far", { place: { x: laid.bounds.x - 2000, y: laid.bounds.y - 2000 } });
    const placed = placeNotes(
      laid,
      index,
      [...blockers, far, note("n1")],
      undefined,
      estimateMeasure,
    );
    const sticky = placed[placed.length - 1];
    for (const other of [...laid.nodes, ...placed.slice(0, -1)]) {
      assert.ok(!overlaps(sticky, other), `note stays off ${other.id}`);
    }
    const dx = Math.max(home.x - sticky.x - sticky.width, 0, sticky.x - home.x - home.width);
    const dy = Math.max(home.y - sticky.y - sticky.height, 0, sticky.y - home.y - home.height);
    assert.ok(
      Math.hypot(dx, dy) < 200,
      `note is ${Math.round(Math.hypot(dx, dy))}px from its target`,
    );
  });

  test("target search ranks name matches before path matches and honours the limit", () => {
    const targets = allTargets(index, FILES);
    const hits = searchTargets(targets, "notif");
    const firstPath = hits.findIndex((hit) => hit.kind === "file");
    assert.ok(firstPath > 0);
    for (const hit of hits.slice(0, firstPath)) {
      assert.ok(/^notif/i.test(hit.label), `${hit.label} is a name match`);
    }
    assert.ok(hits.some((hit) => hit.label === "Notifier"));
    assert.strictEqual(searchTargets(targets, "notif", 3).length, 3);
    assert.deepStrictEqual(searchTargets(targets, "zzz"), []);
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
