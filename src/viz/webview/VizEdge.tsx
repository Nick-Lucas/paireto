import { EdgeLabelRenderer, type Edge, type EdgeProps } from "@xyflow/react";

import type { EdgeData } from "../model/rf";
import { DELTA_GLYPH } from "../model/delta";
import "./edges.css";

const ARROW = 8;
const RADIUS = 8;

function roundedPath(points: readonly { x: number; y: number }[]): string {
  if (points.length < 2) {
    return "";
  }
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const inLen = Math.hypot(here.x - prev.x, here.y - prev.y);
    const outLen = Math.hypot(next.x - here.x, next.y - here.y);
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

function arrowHead(points: readonly { x: number; y: number }[]): string {
  const tip = points[points.length - 1];
  const prev = points[points.length - 2] ?? tip;
  const len = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
  const ux = (tip.x - prev.x) / len;
  const uy = (tip.y - prev.y) / len;
  const bx = tip.x - ux * ARROW;
  const by = tip.y - uy * ARROW;
  const px = -uy * (ARROW / 2);
  const py = ux * (ARROW / 2);
  return `M${bx + px} ${by + py} L${tip.x} ${tip.y} L${bx - px} ${by - py} Z`;
}

export function VizEdge({ data }: EdgeProps<Edge<EdgeData, "viz">>) {
  if (!data) {
    return null;
  }
  const { edge, points, label, level } = data;
  const classes = [
    "viz-edge",
    `viz-edge--${edge.kind}`,
    `viz-edge--${edge.delta}`,
    `viz-level--${level}`,
    edge.hero ? "viz-edge--hero" : "",
    data.selected ? "viz-edge--selected" : "",
  ].join(" ");
  const path = roundedPath(points);
  const trimmed = points.slice();
  const tip = trimmed[trimmed.length - 1];
  const prev = trimmed[trimmed.length - 2];
  if (tip && prev) {
    const len = Math.hypot(tip.x - prev.x, tip.y - prev.y) || 1;
    trimmed[trimmed.length - 1] = {
      x: tip.x - ((tip.x - prev.x) / len) * (ARROW - 1),
      y: tip.y - ((tip.y - prev.y) / len) * (ARROW - 1),
    };
  }
  const linePath = roundedPath(trimmed);
  return (
    <g className={classes}>
      {edge.hero && <path className="viz-edge__glow" d={path} />}
      <path className="viz-edge__hit" d={path} />
      <path className="viz-edge__line" d={linePath} />
      <path className="viz-edge__head" d={arrowHead(points)} />
      {label && edge.label && (
        <EdgeLabelRenderer>
          <div
            className={`viz-edge-label viz-edge-label--${edge.delta} viz-level--${level} ${data.selected ? "viz-edge-label--selected" : ""} ${edge.hero ? "viz-edge-label--hero" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${label.x + label.width / 2}px, ${label.y + label.height / 2}px)`,
            }}
          >
            {edge.delta !== "unchanged" && (
              <span className={`viz-edge-label__glyph viz-delta--${edge.delta}`}>
                {DELTA_GLYPH[edge.delta]}
              </span>
            )}
            <span>{edge.label}</span>
            {data.steps > 0 && <span className="viz-edge-label__steps">{data.steps}</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

export const EDGE_TYPES = { viz: VizEdge };
