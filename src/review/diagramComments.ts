import * as crypto from "node:crypto";

import type { CommentKind } from "../comments/kinds.js";
import type { DiagramAnchor, DiagramLink, ReviewThread } from "./reviewTypes.js";

const DOC_TITLE = "# Comment on the class diagram";

const SCOPE_WORDS: Record<DiagramLink["scope"], string> = {
  type: "the type",
  member: "the member",
  group: "the linked types",
  file: "the types in the file",
};

export function renderDiagramDoc(anchor: DiagramAnchor): string {
  const links =
    anchor.links.length === 0
      ? ["This note is not linked to a part of the diagram yet.", ""]
      : anchor.links.flatMap((link) => [
          `Linked to ${SCOPE_WORDS[link.scope]} ${link.title}:`,
          "",
          ...link.targets.map(
            (target) => `- **${target.name}** at \`${target.filePath}:${target.line + 1}\``,
          ),
          "",
        ]);
  return [
    DOC_TITLE,
    "",
    ...links,
    "---",
    "",
    "This comment was left on the class diagram. Reply to it, edit it or resolve it here.",
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

export function relinkDiagramThread(thread: ReviewThread, anchor: DiagramAnchor): ReviewThread {
  return {
    ...thread,
    diagram: anchor,
    sourceDocument: thread.sourceDocument && {
      ...thread.sourceDocument,
      markdown: renderDiagramDoc(anchor),
    },
  };
}
