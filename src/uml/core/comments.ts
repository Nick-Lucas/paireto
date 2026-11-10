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

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function noteStatus(comment: UmlComment): { meta: string; badge: string } {
  const sent = comment.sent ? (comment.waiting ? "sent · waiting" : "sent") : "not sent";
  if (comment.unread > 0) {
    return { meta: sent, badge: `${counted(comment.unread, "new reply", "new replies")}` };
  }
  const replies = comment.replies > 0 ? `${counted(comment.replies, "reply", "replies")} · ` : "";
  return { meta: `${replies}${sent}`, badge: "" };
}

function partRank(part: UmlCommentLink, query: string): number {
  const title = part.title.toLowerCase();
  const name = part.scope === "file" ? title.slice(title.lastIndexOf("/") + 1) : title;
  if (name.startsWith(query)) {
    return 0;
  }
  if (title.split(/[^a-z0-9_$]+/).some((word) => word.startsWith(query))) {
    return 1;
  }
  return title.includes(query) ? 2 : -1;
}

export function searchParts(
  parts: readonly UmlCommentLink[],
  query: string,
  limit = 8,
): UmlCommentLink[] {
  const text = query.toLowerCase();
  return parts
    .map((part, index) => ({ part, index, rank: partRank(part, text) }))
    .filter((hit) => hit.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, limit)
    .map((hit) => hit.part);
}

export function timeAgo(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${counted(hours, "hour", "hours")} ago`;
  }
  return `${counted(Math.floor(hours / 24), "day", "days")} ago`;
}

export type DiagramThread = Pick<
  ReviewThread,
  "id" | "delivery" | "resolvedAt" | "sentAt" | "items" | "diagram"
>;

export function diagramComments(threads: readonly DiagramThread[]): UmlComment[] {
  return threads.flatMap((thread) => {
    const diagram = thread.diagram;
    if (!diagram || thread.resolvedAt) {
      return [];
    }
    const [opening, ...replies] = thread.items;
    const sentAt = thread.sentAt ?? "";
    const items = thread.items.map((item) => {
      const who =
        item.kind === "reply" && item.author.kind === "agent"
          ? ("agent" as const)
          : ("you" as const);
      return {
        id: item.kind === "reply" ? item.id : thread.id,
        sent: who === "agent" || thread.delivery === "sent" || item.at <= sentAt,
        who,
        body: item.body,
        at: item.at,
      };
    });
    const readAt = diagram.readAt ?? "";
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
        ...(diagram.place ? { place: diagram.place } : {}),
        items,
        unread: items.filter((item) => item.who === "agent" && item.at > readAt).length,
        waiting: thread.delivery === "sent" && items[items.length - 1].who === "you",
      },
    ];
  });
}
