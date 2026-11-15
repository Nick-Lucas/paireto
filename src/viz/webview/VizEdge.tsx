import { EdgeLabelRenderer, type Edge, type EdgeProps } from "@xyflow/react";

import type { VizEdgeKind } from "../../protocol/viz";
import type { Point } from "../layout/geometry";
import { DELTA_GLYPH } from "../model/delta";
import type { EdgeData } from "../model/rf";
import "./edges.css";

const RADIUS = 8;

type Head = "arrow" | "triangle" | "diamond" | "filledDiamond" | "open";

const HEADS: Record<VizEdgeKind, { head: Head; tail?: Head; dashed: boolean }> = {
  call: { head: "arrow", dashed: false },
  event: { head: "arrow", dashed: true },
  data: { head: "arrow", dashed: true },
  render: { head: "arrow", dashed: false },
  uses: { head: "open", dashed: true },
  extends: { head: "triangle", dashed: false },
  implements: { head: "triangle", dashed: true },
  association: { head: "open", dashed: false },
  aggregation: { head: "open", tail: "diamond", dashed: false },
  composition: { head: "open", tail: "filledDiamond", dashed: false },
  dependency: { head: "open", dashed: true },
};

const HEAD_SIZE: Record<Head, number> = {
  arrow: 8,
  open: 9,
  triangle: 12,
  diamond: 14,
  filledDiamond: 14,
};

export function roundedPath(points: readonly Point[]): string {
  if (points.length < 2) {
    return "";
  }
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(here.x - prev.x, here.y - prev.y) || 1;
    const outLen = Math.hypot(next.x - here.x, next.y - here.y) || 1;
    const r = Math.min(RADIUS, inLen / 2, outLen / 2);
    const inX = here.x - ((here.x - prev.x) / inLen) * r;
    const inY = here.y - ((here.y - prev.y) / inLen) * r;
    const outX = here.x + ((next.x - here.x) / outLen) * r;
    const outY = here.y + ((next.y - here.y) / outLen) * r;
    d += ` L${inX} ${inY} Q${here.x} ${here.y} ${outX} ${outY}`;
  }
  const last = points[points.length - 1];
  d += ` L${last.x} ${last.y}`;
  return d;
}

function unit(from: Point, to: Point): Point {
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: (to.x - from.x) / len, y: (to.y - from.y) / len };
}

function headPath(head: Head, tip: Point, dir: Point): string {
  const size = HEAD_SIZE[head];
  const bx = tip.x - dir.x * size;
  const by = tip.y - dir.y * size;
  const px = -dir.y;
  const py = dir.x;
  switch (head) {
    case "arrow": {
      const w = size / 2;
      return `M${bx + px * w} ${by + py * w} L${tip.x} ${tip.y} L${bx - px * w} ${by - py * w} Z`;
    }
    case "open": {
      const w = size / 2.2;
      return `M${bx + px * w} ${by + py * w} L${tip.x} ${tip.y} L${bx - px * w} ${by - py * w}`;
    }
    case "triangle": {
      const w = size / 2;
      return `M${bx + px * w} ${by + py * w} L${tip.x} ${tip.y} L${bx - px * w} ${by - py * w} Z`;
    }
    case "diamond":
    case "filledDiamond": {
      const w = size / 3.2;
      const mx = tip.x - dir.x * (size / 2);
      const my = tip.y - dir.y * (size / 2);
      return `M${tip.x} ${tip.y} L${mx + px * w} ${my + py * w} L${bx} ${by} L${mx - px * w} ${my - py * w} Z`;
    }
  }
}

function shorten(points: readonly Point[], atEnd: boolean, by: number): Point[] {
  const list = points.slice();
  if (list.length < 2 || by === 0) {
    return list;
  }
  const tipIndex = atEnd ? list.length - 1 : 0;
  const prevIndex = atEnd ? list.length - 2 : 1;
  const tip = list[tipIndex];
  const dir = unit(list[prevIndex], tip);
  list[tipIndex] = { x: tip.x - dir.x * by, y: tip.y - dir.y * by };
  return list;
}

function EndLabel({
  rect,
  text,
  level,
}: {
  rect: { x: number; y: number; width: number; height: number };
  text: string;
  level: string;
}) {
  return (
    <div
      className={`viz-edge-mult viz-level--${level}`}
      style={{
        transform: `translate(${rect.x}px, ${rect.y}px)`,
        width: rect.width,
        height: rect.height,
      }}
    >
      {text}
    </div>
  );
}

export function VizEdge({ data }: EdgeProps<Edge<EdgeData, "viz">>) {
  if (!data) {
    return null;
  }
  const { edge, points, label, level } = data;
  const style = HEADS[edge.kind];
  const classes = [
    "viz-edge",
    `viz-edge--${edge.kind}`,
    `viz-edge--${edge.delta}`,
    `viz-level--${level}`,
    edge.hero ? "viz-edge--hero" : "",
    data.selected ? "viz-edge--selected" : "",
    style.dashed ? "viz-edge--dashed" : "",
  ].join(" ");
  if (points.length < 2) {
    return null;
  }
  const tip = points[points.length - 1];
  const headDir = unit(points[points.length - 2], tip);
  const tailDir = unit(points[1], points[0]);
  const filled = style.head === "arrow";
  let line = shorten(points, true, HEAD_SIZE[style.head] - (filled ? 1 : 0.5));
  if (style.tail) {
    line = shorten(line, false, HEAD_SIZE[style.tail] - 0.5);
  }
  const linePath = roundedPath(line);
  const hitPath = roundedPath(points);
  return (
    <g className={classes}>
      {edge.hero && <path className="viz-edge__glow" d={hitPath} />}
      <path className="viz-edge__hit" d={hitPath} />
      <path className="viz-edge__casing" d={linePath} />
      <path className="viz-edge__line" d={linePath} />
      <path
        className={`viz-edge__head viz-edge__head--${style.head}`}
        d={headPath(style.head, tip, headDir)}
      />
      {style.tail && (
        <path
          className={`viz-edge__head viz-edge__head--${style.tail}`}
          d={headPath(style.tail, points[0], tailDir)}
        />
      )}
      <EdgeLabelRenderer>
        {label && edge.label && (
          <div
            className={`viz-edge-label viz-edge-label--${edge.delta} viz-level--${level} ${data.selected ? "viz-edge-label--selected" : ""} ${edge.hero ? "viz-edge-label--hero" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${label.x + label.width / 2}px, ${label.y + label.height / 2}px)`,
              maxWidth: label.width,
            }}
          >
            {edge.delta !== "unchanged" && (
              <span className={`viz-edge-label__glyph viz-delta--${edge.delta}`}>
                {DELTA_GLYPH[edge.delta]}
              </span>
            )}
            <span className="viz-edge-label__text" title={edge.label}>
              {edge.label}
            </span>
            {data.steps > 0 && <span className="viz-edge-label__steps">{data.steps}</span>}
          </div>
        )}
        {data.toLabel && edge.multiplicity?.to && (
          <EndLabel rect={data.toLabel} text={edge.multiplicity.to} level={level} />
        )}
        {data.fromLabel && edge.multiplicity?.from && (
          <EndLabel rect={data.fromLabel} text={edge.multiplicity.from} level={level} />
        )}
      </EdgeLabelRenderer>
    </g>
  );
}
