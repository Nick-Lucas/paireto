import * as assert from "node:assert";

import {
  buildCamera,
  buildEdit,
  cameraAt,
  cursorAt,
  buildCursor,
  type EditStyle,
  segmentDuration,
  sourceToOutput,
} from "../demo/edit.js";
import type { Timeline, TimelineEvent } from "../demo/timeline.js";

const style: EditStyle = {
  fps: 30,
  width: 1920,
  height: 1080,
  inset: 0,
  maxZoom: 2,
  clickZoom: 1.5,
  focusPadding: 1,
  cameraTransitionMs: 500,
  cameraLingerMs: 0,
  cameraLeadMs: 0,
  fastForwardMaxMs: 1000,
  chapterHoldMs: 2000,
  introMs: 3000,
  outroMs: 4000,
};

function timeline(events: TimelineEvent[], durationMs = 20_000): Timeline {
  return {
    video: { file: "capture.mp4", fps: 30, width: 3200, height: 1800, scale: 2, durationMs },
    events,
  };
}

suite("demo edit", () => {
  test("plays the whole capture after the intro when nothing is cut or sped up", () => {
    const edit = buildEdit(timeline([]), style);
    assert.strictEqual(edit.videoStart, 3000);
    assert.strictEqual(edit.videoEnd, 23_000);
    assert.strictEqual(edit.totalMs, 27_000);
  });

  test("squeezes a fast-forward span into the configured length", () => {
    const edit = buildEdit(timeline([{ kind: "fastForward", start: 5000, end: 15_000 }]), style);
    assert.strictEqual(edit.videoEnd - edit.videoStart, 5000 + 1000 + 5000);
    assert.strictEqual(sourceToOutput(edit, 10_000), 3000 + 5000 + 500);
  });

  test("removes a cut span and holds the frame under each chapter card", () => {
    const edit = buildEdit(
      timeline([
        { kind: "cut", start: 2000, end: 4000 },
        { kind: "chapter", at: 6000, title: "Plan your work" },
      ]),
      style,
    );
    const holds = edit.segments.filter((segment) => segment.kind === "hold");
    assert.deepStrictEqual(
      holds.map((hold) => [hold.outStart, hold.kind === "hold" ? hold.title : ""]),
      [[3000 + 2000 + 2000, "Plan your work"]],
    );
    const total = edit.segments.reduce((sum, segment) => sum + segmentDuration(segment), 0);
    assert.strictEqual(total, 18_000 + 2000);
    assert.strictEqual(sourceToOutput(edit, 6000), 3000 + 4000 + 2000);
  });

  test("zooms onto a focused area and returns to the wide shot afterwards", () => {
    const events: TimelineEvent[] = [
      { kind: "focus", start: 4000, end: 8000, rect: { x: 0, y: 0, width: 400, height: 225 } },
    ];
    const edit = buildEdit(timeline(events), style);
    const camera = buildCamera(timeline(events), edit, style);
    assert.strictEqual(cameraAt(camera, 0).zoom, 1);
    const close = cameraAt(camera, sourceToOutput(edit, 6000));
    assert.strictEqual(close.zoom, 2);
    assert.deepStrictEqual([close.x, close.y], [480, 270]);
    assert.strictEqual(cameraAt(camera, sourceToOutput(edit, 15_000)).zoom, 1);
  });

  test("keeps the whole focused area in view when a step asks for a closer zoom", () => {
    const rect = { x: 100, y: 50, width: 300, height: 800 };
    const events: TimelineEvent[] = [{ kind: "focus", start: 4000, end: 8000, rect, zoom: 1.5 }];
    const edit = buildEdit(timeline(events), style);
    const camera = buildCamera(timeline(events), edit, style);
    const view = cameraAt(camera, sourceToOutput(edit, 6000));
    const scale = style.width / 1600;
    const halfWidth = style.width / (2 * view.zoom);
    const halfHeight = style.height / (2 * view.zoom);
    assert.ok(view.x - halfWidth <= rect.x * scale);
    assert.ok(view.x + halfWidth >= (rect.x + rect.width) * scale);
    assert.ok(view.y - halfHeight <= rect.y * scale);
    assert.ok(view.y + halfHeight >= (rect.y + rect.height) * scale);
  });

  test("holds the wide shot over a chapter card even inside a focus span", () => {
    const events: TimelineEvent[] = [
      { kind: "focus", start: 1000, end: 9000, rect: { x: 0, y: 0, width: 400, height: 225 } },
      { kind: "chapter", at: 5000, title: "Review" },
    ];
    const edit = buildEdit(timeline(events), style);
    const camera = buildCamera(timeline(events), edit, style);
    const card = edit.segments.find((segment) => segment.kind === "hold");
    assert.ok(card);
    assert.strictEqual(cameraAt(camera, card.outStart + card.duration / 2).zoom, 1);
  });

  test("moves the cursor along the logged path and rests at its end", () => {
    const events: TimelineEvent[] = [
      { kind: "move", start: 1000, end: 2000, from: { x: 0, y: 0 }, to: { x: 100, y: 50 } },
    ];
    const edit = buildEdit(timeline(events), style);
    const cursor = buildCursor(timeline(events), edit);
    assert.strictEqual(cursorAt(cursor, 0), undefined);
    assert.deepStrictEqual(cursorAt(cursor, sourceToOutput(edit, 1500)), { x: 50, y: 25 });
    assert.deepStrictEqual(cursorAt(cursor, sourceToOutput(edit, 5000)), { x: 100, y: 50 });
  });
});
