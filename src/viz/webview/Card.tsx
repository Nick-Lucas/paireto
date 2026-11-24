import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type { CardData } from "../model/rf";
import { chipOf } from "../model/visible";
import { noteTargetAttr, useViz } from "./context";
import { KindIcon } from "./icons";
import { ChipMark, Counts, FileRefTag, plural } from "./parts";
import "./cards.css";

export function CardNode({ data }: NodeProps<Node<CardData, "card">>) {
  const viz = useViz();
  const { node } = data;
  const classes = [
    "viz-card",
    `viz-card--${node.delta}`,
    `viz-level--${data.level}`,
    data.selected ? "viz-card--selected" : "",
  ].join(" ");
  const file = node.files?.[0];
  return (
    <div
      className={classes}
      title={node.role}
      {...noteTargetAttr({ kind: "node", id: node.id, label: node.label })}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (file) {
          viz.openFile(file, "diff");
        }
      }}
    >
      <Handle type="target" position={Position.Left} className="viz-handle" />
      <Handle type="source" position={Position.Right} className="viz-handle" />
      <div className="viz-card__row">
        <span className={`viz-card__icon viz-card__icon--${node.delta}`}>
          <KindIcon kind={node.kind} size={15} />
        </span>
        <span className={`viz-card__label ${node.delta === "removed" ? "viz-struck" : ""}`}>
          {node.label}
        </span>
        <ChipMark chip={chipOf(node)} />
        {node.counts && (
          <span className="viz-pill">
            <Counts counts={node.counts} />
          </span>
        )}
      </div>
      {node.sub && <div className="viz-card__sub">{node.sub}</div>}
      {file && (
        <div className="viz-card__ref">
          <FileRefTag file={file} />
        </div>
      )}
      <div className="viz-card__meta">
        <span>
          {node.kind}
          {data.files > 1 && ` · ${plural(data.files, "file")}`}
        </span>
        <span className="viz-card__right">
          {data.flows > 0 && (
            <span className="viz-card__flows" title={`In ${plural(data.flows, "flow")}`}>
              {plural(data.flows, "flow")}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
