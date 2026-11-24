import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import { BOX, type BoxRowLayout } from "../layout/classBox";
import type { ClassBoxData } from "../model/rf";
import { noteTargetAttr, useViz } from "./context";
import { ChipMark, CountsText, FileRefTag } from "./parts";
import "./classbox.css";

function Row({
  row,
  nodeId,
  nodeLabel,
  selected,
}: {
  row: BoxRowLayout;
  nodeId: string;
  nodeLabel: string;
  selected: boolean;
}) {
  const viz = useViz();
  const style = { top: row.y, height: BOX.rowHeight };
  if (row.kind === "summary") {
    return (
      <button
        type="button"
        className="viz-row viz-row--summary"
        style={style}
        onClick={(event) => {
          event.stopPropagation();
          if (row.row.kind !== "outside") {
            viz.dispatch({ type: "toggleExpanded", node: nodeId });
          }
        }}
      >
        <span className="viz-row__text">{row.text}</span>
      </button>
    );
  }
  const member = viz.index.memberById.get(row.memberId)?.member;
  const target = noteTargetAttr({
    kind: "member",
    id: row.memberId,
    node: nodeId,
    label: `${nodeLabel}.${member?.short ?? row.full}`,
  });
  const select = () =>
    viz.dispatch({ type: "select", ref: { kind: "member", id: row.memberId, node: nodeId } });
  return (
    <div
      className={`viz-row viz-row--member ${row.chip ? `viz-row--${row.chip}` : "viz-row--U"} ${row.removed ? "viz-row--removed" : ""} ${selected ? "viz-row--selected" : ""}`}
      style={style}
      role="button"
      tabIndex={-1}
      title={row.full}
      {...target}
      onClick={(event) => {
        event.stopPropagation();
        select();
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (member?.file) {
          viz.openFile(member.file, "diff");
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        select();
        viz.openMenu(
          { kind: "member", id: row.memberId, node: nodeId },
          { x: event.clientX, y: event.clientY },
        );
      }}
    >
      <Handle
        type="target"
        position={Position.Left}
        id={`in/${row.memberId}`}
        className="viz-handle"
      />
      <ChipMark chip={row.chip} />
      <span
        className={`viz-row__text ${row.isStatic ? "viz-row__text--static" : ""} ${row.isAbstract ? "viz-row__text--abstract" : ""}`}
      >
        {row.text}
      </span>
      {row.counts && <CountsText text={row.counts} />}
      <Handle
        type="source"
        position={Position.Right}
        id={`out/${row.memberId}`}
        className="viz-handle"
      />
    </div>
  );
}

export function ClassBoxNode({ data }: NodeProps<Node<ClassBoxData, "classBox">>) {
  const viz = useViz();
  const { node, box } = data;
  const classes = [
    "viz-box",
    `viz-box--${node.delta}`,
    `viz-level--${data.level}`,
    data.selected ? "viz-box--selected" : "",
    box.noDiff ? "viz-box--quiet" : "",
  ].join(" ");
  const target = noteTargetAttr({ kind: "node", id: node.id, label: node.label });
  const file = node.files?.[0];
  return (
    <div className={classes} style={{ width: box.width, height: box.height }} {...target}>
      <Handle type="target" position={Position.Left} className="viz-handle" />
      <Handle type="source" position={Position.Right} className="viz-handle" />
      <header
        className="viz-box__head"
        style={{ height: box.headerHeight }}
        title={node.role ?? node.label}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (file) {
            viz.openFile(file, "diff");
          }
        }}
      >
        {box.stereotype && <div className="viz-box__stereotype">{box.stereotype}</div>}
        <div className="viz-box__title">
          <ChipMark chip={box.chip} />
          <span
            className={`viz-box__name ${node.isAbstract ? "viz-box__name--abstract" : ""} ${node.delta === "removed" ? "viz-struck" : ""}`}
          >
            {box.title}
          </span>
          {!box.noDiff && (
            <span
              className={`viz-box__seen ${data.seen ? "viz-box__seen--on" : ""}`}
              title={data.seen ? "File seen" : "File not seen yet"}
            />
          )}
          {box.counts && (
            <span className="viz-pill">
              <CountsText text={box.counts} />
            </span>
          )}
          {box.noDiff && <span className="viz-pill viz-pill--muted">no diff</span>}
        </div>
        {file && box.ref && <FileRefTag file={file} text={box.ref} />}
      </header>
      {box.dividers.map((y) => (
        <span key={y} className="viz-box__divider" style={{ top: y }} />
      ))}
      {box.rows.map((row) => (
        <Row
          key={row.kind === "member" ? row.memberId : `summary/${row.y}`}
          row={row}
          nodeId={node.id}
          nodeLabel={node.label}
          selected={row.kind === "member" && row.memberId === data.selectedMember}
        />
      ))}
    </div>
  );
}
