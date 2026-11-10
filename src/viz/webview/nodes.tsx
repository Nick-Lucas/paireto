import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

import type {
  ActivationData,
  CardData,
  GroupData,
  LaneData,
  MessageData,
  ParticipantData,
  PhaseData,
} from "../model/rf";
import { DeltaBadge, DELTA_GLYPH, KindIcon } from "./icons";
import "./cards.css";
import "./sequence.css";

const levelClass = (level: string) => `viz-level--${level}`;

function LaneNode({ data }: NodeProps<Node<LaneData, "lane">>) {
  return (
    <div className={`viz-lane ${data.even ? "viz-lane--even" : "viz-lane--odd"}`}>
      <div className="viz-lane__label">{data.label}</div>
    </div>
  );
}

function GroupNode({ data }: NodeProps<Node<GroupData, "group">>) {
  return (
    <div className={`viz-group ${levelClass(data.level)}`}>
      <div className="viz-group__label">{data.label}</div>
    </div>
  );
}

function CardNode({ data }: NodeProps<Node<CardData, "card">>) {
  const { node } = data;
  const classes = [
    "viz-card",
    `viz-card--${node.delta}`,
    levelClass(data.level),
    data.selected ? "viz-card--selected" : "",
  ].join(" ");
  const meta = [node.kind, data.files > 0 ? `${data.files} file${data.files === 1 ? "" : "s"}` : ""]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className={classes} title={node.role}>
      <Handle type="target" position={Position.Left} className="viz-handle" />
      <Handle type="source" position={Position.Right} className="viz-handle" />
      <div className="viz-card__row">
        <span className={`viz-card__icon viz-card__icon--${node.delta}`}>
          <KindIcon kind={node.kind} />
        </span>
        <span className="viz-card__label">{node.label}</span>
        <DeltaBadge delta={node.delta} compact />
      </div>
      {node.sub && <div className="viz-card__sub">{node.sub}</div>}
      <div className="viz-card__meta">
        <span>{meta}</span>
        {data.flows > 0 && (
          <span
            className="viz-card__flows"
            title={`In ${data.flows} flow${data.flows === 1 ? "" : "s"}`}
          >
            {data.flows} flow{data.flows === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}

function ParticipantNode({ data }: NodeProps<Node<ParticipantData, "participant">>) {
  const { node } = data;
  const classes = [
    "viz-participant",
    `viz-participant--${node.delta}`,
    levelClass(data.level),
    data.selected ? "viz-participant--selected" : "",
  ].join(" ");
  return (
    <div className={classes} title={node.role}>
      <span className={`viz-card__icon viz-card__icon--${node.delta}`}>
        <KindIcon kind={node.kind} />
      </span>
      <span className="viz-participant__text">
        <span className="viz-participant__label">{node.label}</span>
        {node.sub && <span className="viz-participant__sub">{node.sub}</span>}
      </span>
      <span className={`viz-delta viz-delta--${node.delta}`}>{DELTA_GLYPH[node.delta]}</span>
    </div>
  );
}

function LifelineNode() {
  return <div className="viz-lifeline" />;
}

function ActivationNode({ data }: NodeProps<Node<ActivationData, "activation">>) {
  return <div className={`viz-activation ${levelClass(data.level)}`} />;
}

function PhaseNode({ data }: NodeProps<Node<PhaseData, "phase">>) {
  return (
    <div className="viz-phase">
      <span className="viz-phase__label">{data.label}</span>
    </div>
  );
}

const ARROW = 7;

function MessageNode({ data, width, height }: NodeProps<Node<MessageData, "message">>) {
  const { step } = data;
  const w = width ?? 0;
  const h = height ?? 0;
  const classes = [
    "viz-message",
    `viz-message--${step.kind}`,
    `viz-message--${step.delta}`,
    `viz-message--${data.direction}`,
    levelClass(data.level),
    data.selected ? "viz-message--selected" : "",
    data.current ? "viz-message--current" : "",
  ].join(" ");
  const dashed = step.kind === "return";
  const filledHead = step.kind === "sync";
  const y = data.lineY;
  let line: string;
  let head: string;
  if (data.direction === "self") {
    const loopW = 36;
    const bottom = y + 24;
    line = `M${data.fromX} ${y} H${data.fromX + loopW} V${bottom} H${data.fromX + ARROW}`;
    head = `M${data.fromX + ARROW + 1} ${bottom - ARROW / 2 - 1} L${data.fromX + 1} ${bottom} L${data.fromX + ARROW + 1} ${bottom + ARROW / 2 + 1}`;
  } else {
    const dir = data.direction === "right" ? 1 : -1;
    const tip = data.toX;
    const base = tip - dir * ARROW;
    line = `M${data.fromX} ${y} L${base} ${y}`;
    head = `M${base} ${y - ARROW / 2} L${tip} ${y} L${base} ${y + ARROW / 2}`;
  }
  const labelStyle =
    data.direction === "self"
      ? { left: data.fromX + 44, top: y - 2, transform: "translateY(-50%)" }
      : { left: w / 2, top: y - 6, transform: "translate(-50%, -100%)" };
  return (
    <div className={classes} style={{ width: w, height: h }}>
      <svg className="viz-message__svg" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
        <path className="viz-message__hit" d={line} />
        <path className="viz-message__line" d={line} strokeDasharray={dashed ? "6 4" : undefined} />
        <path
          className={`viz-message__head ${filledHead ? "viz-message__head--filled" : ""}`}
          d={head}
        />
      </svg>
      <div className="viz-message__label" style={labelStyle}>
        <span className="viz-message__number">{step.index + 1}</span>
        <span className="viz-message__text">{step.label}</span>
        {step.delta !== "unchanged" && (
          <span className={`viz-delta viz-delta--${step.delta}`}>{DELTA_GLYPH[step.delta]}</span>
        )}
      </div>
    </div>
  );
}

export const NODE_TYPES = {
  lane: LaneNode,
  group: GroupNode,
  card: CardNode,
  participant: ParticipantNode,
  lifeline: LifelineNode,
  activation: ActivationNode,
  phase: PhaseNode,
  message: MessageNode,
};
