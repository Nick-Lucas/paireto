import { CardNode } from "./Card";
import { ClassBoxNode } from "./ClassBox";
import { FrameNode, LaneNode } from "./Frame";
import { NoteEdge } from "./NoteEdge";
import { NoteNode } from "./NoteNode";
import {
  ActivationNode,
  FragmentNode,
  LifelineNode,
  MessageNode,
  ParticipantNode,
  PhaseNode,
} from "./sequence";
import { VizEdge } from "./VizEdge";

export const NODE_TYPES = {
  lane: LaneNode,
  frame: FrameNode,
  classBox: ClassBoxNode,
  card: CardNode,
  participant: ParticipantNode,
  lifeline: LifelineNode,
  activation: ActivationNode,
  phase: PhaseNode,
  fragment: FragmentNode,
  message: MessageNode,
  note: NoteNode,
};

export const EDGE_TYPES = { viz: VizEdge, noteLink: NoteEdge };
