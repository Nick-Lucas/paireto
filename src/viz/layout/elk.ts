import type { Point } from "./geometry.js";

export interface ElkLabel {
  text?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
}

export interface ElkPort {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  layoutOptions?: Record<string, string>;
}

export interface ElkNode {
  id: string;
  layoutOptions?: Record<string, string>;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  ports?: ElkPort[];
  edges?: ElkEdge[];
  labels?: ElkLabel[];
}

export interface ElkEdge {
  id: string;
  sources: string[];
  targets: string[];
  container?: string;
  labels?: ElkLabel[];
  layoutOptions?: Record<string, string>;
  sections?: { startPoint: Point; endPoint: Point; bendPoints?: Point[] }[];
}

export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}
