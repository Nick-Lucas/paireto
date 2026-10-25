import type { Point, Rect, Timeline, TimelineEvent } from "./timeline.js";

export interface EditStyle {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly inset: number;
  readonly maxZoom: number;
  readonly clickZoom: number;
  readonly focusPadding: number;
  readonly cameraTransitionMs: number;
  readonly cameraLingerMs: number;
  readonly cameraLeadMs: number;
  readonly fastForwardMaxMs: number;
  readonly chapterHoldMs: number;
  readonly introMs: number;
  readonly outroMs: number;
}

export type Segment =
  | {
      readonly kind: "play";
      readonly outStart: number;
      readonly srcStart: number;
      readonly srcEnd: number;
      readonly rate: number;
    }
  | {
      readonly kind: "hold";
      readonly outStart: number;
      readonly srcAt: number;
      readonly duration: number;
      readonly title: string;
    };

export interface Edit {
  readonly segments: readonly Segment[];
  readonly videoStart: number;
  readonly videoEnd: number;
  readonly totalMs: number;
}

export function segmentDuration(segment: Segment): number {
  return segment.kind === "play"
    ? (segment.srcEnd - segment.srcStart) / segment.rate
    : segment.duration;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

export function buildEdit(timeline: Timeline, style: EditStyle): Edit {
  const duration = timeline.video.durationMs;
  const cuts = mergeSpans(spansOf(timeline.events, "cut"), duration);
  const fastForwards = mergeSpans(spansOf(timeline.events, "fastForward"), duration);
  const chapters = timeline.events
    .filter(
      (event): event is Extract<TimelineEvent, { kind: "chapter" }> => event.kind === "chapter",
    )
    .filter((chapter) => !cuts.some((cut) => chapter.at > cut.start && chapter.at < cut.end))
    .sort((a, b) => a.at - b.at);

  const boundaries = new Set<number>([0, duration]);
  for (const span of [...cuts, ...fastForwards]) {
    boundaries.add(span.start);
    boundaries.add(span.end);
  }
  for (const chapter of chapters) {
    boundaries.add(clamp(chapter.at, 0, duration));
  }
  const points = [...boundaries].sort((a, b) => a - b);

  const segments: Segment[] = [];
  let out = style.introMs;
  const pushHolds = (at: number): void => {
    for (const chapter of chapters.filter((c) => clamp(c.at, 0, duration) === at)) {
      segments.push({
        kind: "hold",
        outStart: out,
        srcAt: at,
        duration: style.chapterHoldMs,
        title: chapter.title,
      });
      out += style.chapterHoldMs;
    }
  };
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    pushHolds(start);
    if (end <= start || cuts.some((cut) => start >= cut.start && end <= cut.end)) {
      continue;
    }
    const fastForward = fastForwards.find((span) => start >= span.start && end <= span.end);
    const length = end - start;
    const rate = fastForward ? Math.max(1, fastForwardRate(fastForward, style)) : 1;
    segments.push({ kind: "play", outStart: out, srcStart: start, srcEnd: end, rate });
    out += length / rate;
  }
  pushHolds(duration);
  return {
    segments,
    videoStart: style.introMs,
    videoEnd: out,
    totalMs: out + style.outroMs,
  };
}

function fastForwardRate(span: Span, style: EditStyle): number {
  return (span.end - span.start) / style.fastForwardMaxMs;
}

function spansOf(events: readonly TimelineEvent[], kind: "cut" | "fastForward"): Span[] {
  return events
    .filter((event): event is Extract<TimelineEvent, { kind: typeof kind }> => event.kind === kind)
    .map((event) => ({ start: event.start, end: event.end }));
}

function mergeSpans(spans: readonly Span[], duration: number): Span[] {
  const sorted = spans
    .map((span) => ({ start: clamp(span.start, 0, duration), end: clamp(span.end, 0, duration) }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

export function sourceToOutput(edit: Edit, src: number): number {
  let best = edit.videoStart;
  for (const segment of edit.segments) {
    if (segment.kind === "hold") {
      if (src >= segment.srcAt) {
        best = segment.outStart + segment.duration;
      }
      continue;
    }
    if (src < segment.srcStart) {
      return best;
    }
    if (src < segment.srcEnd) {
      return segment.outStart + (src - segment.srcStart) / segment.rate;
    }
    best = segment.outStart + segmentDuration(segment);
  }
  return best;
}

export function segmentAt(edit: Edit, out: number): Segment | undefined {
  return edit.segments.find(
    (segment) => out >= segment.outStart && out < segment.outStart + segmentDuration(segment),
  );
}

export interface Frame {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly width: number;
  readonly height: number;
}

export function screenFrame(timeline: Timeline, style: EditStyle): Frame {
  const logicalWidth = timeline.video.width / timeline.video.scale;
  const logicalHeight = timeline.video.height / timeline.video.scale;
  const scale = Math.min(
    (style.width * (1 - 2 * style.inset)) / logicalWidth,
    (style.height * (1 - 2 * style.inset)) / logicalHeight,
  );
  const width = logicalWidth * scale;
  const height = logicalHeight * scale;
  return {
    scale,
    width,
    height,
    offsetX: (style.width - width) / 2,
    offsetY: (style.height - height) / 2,
  };
}

export function toStage(frame: Frame, point: Point): Point {
  return { x: frame.offsetX + point.x * frame.scale, y: frame.offsetY + point.y * frame.scale };
}

export interface CameraState {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

interface Shot {
  start: number;
  end: number;
  camera: CameraState;
}

export interface CameraTrack {
  readonly keys: readonly { readonly t: number; readonly camera: CameraState }[];
}

export function buildCamera(timeline: Timeline, edit: Edit, style: EditStyle): CameraTrack {
  const frame = screenFrame(timeline, style);
  const wide: CameraState = { x: style.width / 2, y: style.height / 2, zoom: 1 };
  const shots: Shot[] = [];
  const wides: Span[] = [];
  for (const event of timeline.events) {
    if (event.kind === "focus") {
      shots.push({
        start: sourceToOutput(edit, event.start) - style.cameraLeadMs,
        end: sourceToOutput(edit, event.end) + style.cameraLingerMs,
        camera: cameraFor(frame, event.rect, style, event.zoom),
      });
    } else if (event.kind === "wide") {
      wides.push({
        start: sourceToOutput(edit, event.start),
        end: sourceToOutput(edit, event.end),
      });
    }
  }
  for (const segment of edit.segments) {
    if (segment.kind === "hold") {
      wides.push({ start: segment.outStart, end: segment.outStart + segment.duration });
    }
  }
  shots.sort((a, b) => a.start - b.start);

  const timed = trimShots(shots, wides);
  const keys: { t: number; camera: CameraState }[] = [{ t: 0, camera: wide }];
  let current = wide;
  let currentUntil = 0;
  for (const shot of timed) {
    const gap = shot.start - currentUntil;
    if (current !== wide && gap > style.cameraTransitionMs * 2) {
      keys.push({ t: currentUntil, camera: current });
      keys.push({ t: currentUntil + style.cameraTransitionMs, camera: wide });
      current = wide;
    }
    const departAt = Math.max(shot.start - style.cameraTransitionMs, keys.at(-1)?.t ?? 0);
    keys.push({ t: departAt, camera: current });
    keys.push({
      t: Math.max(shot.start, departAt + style.cameraTransitionMs / 2),
      camera: shot.camera,
    });
    current = shot.camera;
    currentUntil = Math.max(shot.end, keys.at(-1)?.t ?? 0);
  }
  if (current !== wide) {
    keys.push({ t: currentUntil, camera: current });
    keys.push({ t: currentUntil + style.cameraTransitionMs, camera: wide });
  }
  return { keys: monotonic(keys) };
}

function trimShots(shots: readonly Shot[], wides: readonly Span[]): Shot[] {
  const out: Shot[] = [];
  for (const shot of shots) {
    let pieces: Shot[] = [{ ...shot }];
    for (const wide of wides) {
      pieces = pieces.flatMap((piece) => {
        if (wide.end <= piece.start || wide.start >= piece.end) {
          return [piece];
        }
        const parts: Shot[] = [];
        if (wide.start > piece.start) {
          parts.push({ ...piece, end: wide.start });
        }
        if (wide.end < piece.end) {
          parts.push({ ...piece, start: wide.end });
        }
        return parts;
      });
    }
    out.push(...pieces.filter((piece) => piece.end - piece.start > 150));
  }
  return out.sort((a, b) => a.start - b.start);
}

function monotonic(
  keys: readonly { t: number; camera: CameraState }[],
): { t: number; camera: CameraState }[] {
  const out: { t: number; camera: CameraState }[] = [];
  for (const key of keys) {
    const last = out.at(-1);
    if (last && key.t <= last.t) {
      out[out.length - 1] = { t: last.t, camera: key.camera };
    } else {
      out.push(key);
    }
  }
  return out;
}

export function cameraFor(
  frame: Frame,
  rect: Rect,
  style: EditStyle,
  zoomOverride?: number,
): CameraState {
  const topLeft = toStage(frame, { x: rect.x, y: rect.y });
  const width = rect.width * frame.scale * style.focusPadding;
  const height = rect.height * frame.scale * style.focusPadding;
  const fit = Math.min(style.width / width, style.height / height);
  const zoom = clamp(Math.min(zoomOverride ?? fit, fit), 1, style.maxZoom);
  const halfWidth = style.width / (2 * zoom);
  const halfHeight = style.height / (2 * zoom);
  return {
    zoom,
    x: clamp(topLeft.x + (rect.width * frame.scale) / 2, halfWidth, style.width - halfWidth),
    y: clamp(topLeft.y + (rect.height * frame.scale) / 2, halfHeight, style.height - halfHeight),
  };
}

export function cameraAt(track: CameraTrack, t: number): CameraState {
  const { keys } = track;
  if (t <= keys[0].t) {
    return keys[0].camera;
  }
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const p = easeInOutCubic((t - a.t) / Math.max(1, b.t - a.t));
      const zoom = a.camera.zoom * Math.pow(b.camera.zoom / a.camera.zoom, p);
      return {
        zoom,
        x: lerp(a.camera.x, b.camera.x, p),
        y: lerp(a.camera.y, b.camera.y, p),
      };
    }
  }
  return keys[keys.length - 1].camera;
}

export interface CursorTrack {
  readonly moves: readonly { start: number; end: number; from: Point; to: Point }[];
  readonly clicks: readonly { at: number; point: Point }[];
}

export function buildCursor(timeline: Timeline, edit: Edit): CursorTrack {
  const moves = timeline.events
    .filter((event): event is Extract<TimelineEvent, { kind: "move" }> => event.kind === "move")
    .map((event) => ({
      start: sourceToOutput(edit, event.start),
      end: sourceToOutput(edit, event.end),
      from: event.from,
      to: event.to,
    }))
    .sort((a, b) => a.start - b.start);
  const clicks = timeline.events
    .filter((event): event is Extract<TimelineEvent, { kind: "click" }> => event.kind === "click")
    .map((event) => ({ at: sourceToOutput(edit, event.at), point: event.point }));
  return { moves, clicks };
}

export function cursorAt(track: CursorTrack, t: number): Point | undefined {
  let position: Point | undefined;
  for (const move of track.moves) {
    if (move.start > t) {
      break;
    }
    if (t >= move.end) {
      position = move.to;
      continue;
    }
    const p = easeInOutCubic((t - move.start) / Math.max(1, move.end - move.start));
    return { x: lerp(move.from.x, move.to.x, p), y: lerp(move.from.y, move.to.y, p) };
  }
  return position;
}

export function easeInOutCubic(p: number): number {
  const x = clamp(p, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function lerp(a: number, b: number, p: number): number {
  return a + (b - a) * p;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
