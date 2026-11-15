import * as crypto from "node:crypto";
import { join } from "node:path";

import type { CommentKind } from "../comments/kinds.js";
import { editFeedback } from "./feedbackState.js";
import type { DiagramAnchor, DiagramTarget, ReviewThread } from "./reviewTypes.js";

const DOC_TITLE = "# Comment on the viz";

export function vizFileOf(anchor: DiagramAnchor): string {
  return `.paireto/viz/${anchor.viz}.viz.json`;
}

export function diagramTargetLine(target: DiagramTarget, multiRepository: boolean): string {
  const code = target.code;
  const at = code
    ? ` at ${multiRepository ? join(code.repoRoot, code.path) : code.path}:${code.line}`
    : "";
  const id = target.kind === "file" ? "" : ` [id: ${target.id}]`;
  return `- ${target.label} (${target.kind})${at}${id}`;
}

export function diagramHeading(anchor: DiagramAnchor): string {
  return `Viz "${anchor.title}" (${vizFileOf(anchor)})`;
}

export function renderDiagramDoc(anchor: DiagramAnchor): string {
  const targets =
    anchor.targets.length === 0
      ? ["This note is not linked to a part of the viz yet.", ""]
      : ["Linked to:", "", ...anchor.targets.map((target) => diagramTargetLine(target, false)), ""];
  return [
    DOC_TITLE,
    "",
    `${diagramHeading(anchor)}.`,
    "",
    ...targets,
    "---",
    "",
    "This comment was left on the viz. Reply to it, edit it or resolve it here.",
  ].join("\n");
}

export function diagramThread(args: {
  id: string;
  at: string;
  kind: CommentKind;
  body: string;
  uri: string;
  repoRoot: string;
  anchor: DiagramAnchor;
}): ReviewThread {
  const markdown = renderDiagramDoc(args.anchor);
  return {
    id: args.id,
    sourceUri: args.uri,
    repoRoot: args.repoRoot,
    filePath: "",
    diagram: args.anchor,
    side: "modified",
    line: 0,
    delivery: "pending",
    createdAt: args.at,
    updatedAt: args.at,
    items: [
      { kind: "comment", commentKind: args.kind, body: args.body, quote: DOC_TITLE, at: args.at },
    ],
    sourceDocument: { uri: args.uri, markdown },
    anchor: {
      lineText: DOC_TITLE,
      contextBefore: [],
      contextAfter: [],
      lineHash: crypto.createHash("sha1").update(DOC_TITLE).digest("hex"),
    },
  };
}

export function placeDiagramThread(
  thread: ReviewThread,
  place: NonNullable<DiagramAnchor["place"]>,
): ReviewThread {
  return { ...thread, diagram: thread.diagram && { ...thread.diagram, place } };
}

export function readDiagramThread(thread: ReviewThread, at: string): ReviewThread {
  return { ...thread, diagram: thread.diagram && { ...thread.diagram, readAt: at } };
}

export function relinkDiagramThread(thread: ReviewThread, anchor: DiagramAnchor): ReviewThread {
  const place = thread.diagram?.place;
  const readAt = thread.diagram?.readAt;
  return {
    ...thread,
    diagram: { ...anchor, ...(place ? { place } : {}), ...(readAt ? { readAt } : {}) },
    sourceDocument: thread.sourceDocument && {
      ...thread.sourceDocument,
      markdown: renderDiagramDoc(anchor),
    },
  };
}

export function editDiagramThread(
  thread: ReviewThread,
  edit: { kind: CommentKind; body: string; anchor: DiagramAnchor; at: string },
): ReviewThread {
  const edited = relinkDiagramThread(editFeedback(thread, edit.body, edit.at), edit.anchor);
  const [opening, ...rest] = edited.items;
  return { ...edited, items: [{ ...opening, commentKind: edit.kind }, ...rest] };
}
