import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { FrameData, LaneData } from "../model/rf";
import { noteTargetAttr, useViz } from "./context";
import { UiIcon } from "./icons";
import { CountsText, FileRefTag } from "./parts";
import "./frame.css";

export function LaneNode({ data }: NodeProps<Node<LaneData, "lane">>) {
  return (
    <div className={`viz-lane ${data.even ? "viz-lane--even" : "viz-lane--odd"}`}>
      <div className="viz-lane__label">{data.label}</div>
    </div>
  );
}

export function FrameNode({ data }: NodeProps<Node<FrameData, "frame">>) {
  const viz = useViz();
  const { frame } = data;
  const classes = [
    "viz-frame",
    `viz-frame--${frame.kind}`,
    `viz-level--${data.level}`,
    data.selected ? "viz-frame--selected" : "",
  ].join(" ");
  const target = frame.node
    ? noteTargetAttr({ kind: "node", id: frame.node.id, label: frame.node.label })
    : {};
  return (
    <div className={classes} title={frame.node?.role ?? frame.label}>
      {frame.node && <Handle type="target" position={Position.Left} className="viz-handle" />}
      {frame.node && <Handle type="source" position={Position.Right} className="viz-handle" />}
      <div
        className="viz-frame__head"
        {...target}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          viz.openMenu({ kind: "frame", frame }, { x: event.clientX, y: event.clientY });
        }}
      >
        <UiIcon name={frame.kind === "folder" ? "folder" : "group"} size={13} />
        <span className="viz-frame__title">{data.title}</span>
        {frame.node?.files?.[0] && <FileRefTag file={frame.node.files[0]} />}
        {frame.counts && (
          <span className="viz-pill">
            <CountsText text={frame.counts} />
          </span>
        )}
      </div>
    </div>
  );
}
