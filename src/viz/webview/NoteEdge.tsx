import type { Edge, EdgeProps } from "@xyflow/react";

import type { NoteLinkData } from "../model/rf";

const HEAD = 8;

export function NoteEdge({ data }: EdgeProps<Edge<NoteLinkData, "noteLink">>) {
  if (!data) {
    return null;
  }
  const { from, to } = data.link;
  const len = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const bx = to.x - ux * HEAD;
  const by = to.y - uy * HEAD;
  const px = -uy * (HEAD / 2);
  const py = ux * (HEAD / 2);
  const classes = [
    "viz-notelink",
    `viz-notelink--${data.noteKind}`,
    data.lit ? "viz-notelink--lit" : "",
  ].join(" ");
  return (
    <g className={classes}>
      <line className="viz-notelink__line" x1={from.x} y1={from.y} x2={bx} y2={by} />
      <path
        className="viz-notelink__head"
        d={`M${bx + px} ${by + py} L${to.x} ${to.y} L${bx - px} ${by - py} Z`}
      />
    </g>
  );
}
