import type { Node, NodeProps } from "@xyflow/react";

import { DELTA_GLYPH } from "../model/delta";
import type {
  ActivationData,
  FragmentData,
  MessageData,
  ParticipantData,
  PhaseData,
} from "../model/rf";
import { chipOf } from "../model/visible";
import { KindIcon } from "./icons";
import { ChipMark } from "./parts";
import "./sequence.css";

export function ParticipantNode({ data }: NodeProps<Node<ParticipantData, "participant">>) {
  const { node } = data;
  const classes = [
    "viz-participant",
    `viz-participant--${node.delta}`,
    `viz-level--${data.level}`,
    data.selected ? "viz-participant--selected" : "",
  ].join(" ");
  return (
    <div className={classes} title={node.role}>
      <span className={`viz-card__icon viz-card__icon--${node.delta}`}>
        <KindIcon kind={node.kind} />
      </span>
      <span className="viz-participant__text">
        <span className={`viz-participant__label ${node.delta === "removed" ? "viz-struck" : ""}`}>
          {node.label}
        </span>
        {node.sub && <span className="viz-participant__sub">{node.sub}</span>}
      </span>
      <ChipMark chip={chipOf(node)} />
    </div>
  );
}

export function LifelineNode() {
  return <div className="viz-lifeline" />;
}

export function ActivationNode({ data }: NodeProps<Node<ActivationData, "activation">>) {
  return <div className={`viz-activation viz-level--${data.level}`} />;
}

export function PhaseNode({ data }: NodeProps<Node<PhaseData, "phase">>) {
  return (
    <div className="viz-phase">
      <span className="viz-phase__label">{data.label}</span>
    </div>
  );
}

export function FragmentNode({ data }: NodeProps<Node<FragmentData, "fragment">>) {
  const { fragment } = data;
  return (
    <div className={`viz-fragment viz-fragment--${fragment.kind}`}>
      <span className="viz-fragment__tag">{fragment.kind}</span>
      {fragment.label && <span className="viz-fragment__guard">[{fragment.label}]</span>}
    </div>
  );
}

const ARROW = 7;

export function MessageNode({ data, width, height }: NodeProps<Node<MessageData, "message">>) {
  const { step } = data;
  const w = width ?? 0;
  const h = height ?? 0;
  const classes = [
    "viz-message",
    `viz-message--${step.kind}`,
    `viz-message--${step.delta}`,
    `viz-message--${data.direction}`,
    `viz-level--${data.level}`,
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
