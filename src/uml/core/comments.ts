import type {
  DiagramAnchor,
  DiagramLink,
  DiagramTarget,
  ReviewThread,
} from "../../review/reviewTypes.js";
import type { UmlComment, UmlCommentLink, UmlModel } from "./model.js";

export function diagramLink(model: UmlModel, link: UmlCommentLink): DiagramLink | undefined {
  const files = new Map(model.files.map((f) => [f.key, f]));
  const types = new Map(model.types.map((t) => [t.id, t]));
  const typeIds =
    link.scope === "file"
      ? model.types.filter((t) => t.fileKey === link.fileKey && !t.context).map((t) => t.id)
      : link.scope === "group"
        ? link.typeIds
        : link.typeIds.slice(0, 1);
  const member =
    link.scope === "member"
      ? types.get(typeIds[0])?.members.find((m) => m.id === link.memberId)
      : undefined;
  const targets: DiagramTarget[] = typeIds.flatMap((id) => {
    const type = types.get(id);
    const file = type && files.get(type.fileKey);
    if (!type || !file) {
      return [];
    }
    return [
      {
        repoRoot: file.repoRoot,
        name: member ? `${type.name}.${member.name}` : type.name,
        filePath: file.path,
        line: member ? member.span.start : (type.span?.start ?? 0),
      },
    ];
  });
  if (targets.length === 0 || (link.scope === "member" && !member)) {
    return undefined;
  }
  const title =
    link.scope === "group"
      ? link.title
      : link.scope === "file"
        ? (files.get(link.fileKey ?? "")?.path ?? link.title)
        : targets[0].name;
  return {
    scope: link.scope,
    title,
    typeIds,
    memberId: member?.id,
    fileKey: link.scope === "file" ? link.fileKey : undefined,
    targets,
  };
}

export function linksTitle(links: readonly { title: string }[]): string {
  return links.length === 0
    ? "Not linked"
    : links.length === 1
      ? links[0].title
      : `${links[0].title} and ${links.length - 1} more`;
}

export function diagramAnchor(links: DiagramLink[]): DiagramAnchor {
  return { title: linksTitle(links), links };
}

export function sameLink(a: UmlCommentLink, b: UmlCommentLink): boolean {
  return (
    a.scope === b.scope &&
    a.memberId === b.memberId &&
    a.fileKey === b.fileKey &&
    a.typeIds.join("|") === b.typeIds.join("|")
  );
}

export type DiagramThread = Pick<
  ReviewThread,
  "id" | "delivery" | "resolvedAt" | "items" | "diagram"
>;

export function diagramComments(threads: readonly DiagramThread[]): UmlComment[] {
  return threads.flatMap((thread) => {
    const diagram = thread.diagram;
    if (!diagram || thread.resolvedAt) {
      return [];
    }
    const [opening, ...replies] = thread.items;
    return [
      {
        id: thread.id,
        kind: opening.commentKind,
        body: opening.body,
        replies: replies.length,
        sent: thread.delivery === "sent",
        links: diagram.links.map((link) => ({
          scope: link.scope,
          title: link.title,
          typeIds: link.typeIds,
          memberId: link.memberId,
          fileKey: link.fileKey,
        })),
      },
    ];
  });
}
