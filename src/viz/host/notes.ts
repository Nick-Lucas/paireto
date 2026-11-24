import { canonicalize } from "../../protocol/paths.js";
import type { VizFileRef } from "../../protocol/viz.js";
import type { DiagramCode, DiagramTarget, ReviewThread } from "../../review/reviewTypes.js";
import { edgeId } from "../model/refs.js";
import type { VizDoc } from "../model/types.js";
import type { VizNote, VizNoteItem, VizNoteTarget } from "../protocol.js";

export function notesTitle(targets: readonly { label: string }[]): string {
  return targets.length === 0
    ? "Whole diagram"
    : targets.length === 1
      ? targets[0].label
      : `${targets[0].label} and ${targets.length - 1} more`;
}

export function diagramTargets(doc: VizDoc, targets: readonly VizNoteTarget[]): DiagramTarget[] {
  return targets.map((target) => {
    const code = codeOf(doc, target);
    return code ? { ...target, code } : { ...target };
  });
}

export function sameTarget(a: VizNoteTarget, b: VizNoteTarget): boolean {
  if (a.kind === "file") {
    return b.kind === "file" && a.repo === b.repo && a.path === b.path;
  }
  if (a.kind === "step") {
    return b.kind === "step" && a.flow === b.flow && a.index === b.index;
  }
  if (b.kind === "step" || b.kind === "file") {
    return false;
  }
  return a.kind === b.kind && a.id === b.id;
}

export function noteTarget(target: DiagramTarget): VizNoteTarget {
  switch (target.kind) {
    case "node":
    case "edge":
      return { kind: target.kind, id: target.id, label: target.label };
    case "member":
      return { kind: "member", id: target.id, node: target.node, label: target.label };
    case "step":
      return { kind: "step", flow: target.flow, index: target.index, label: target.label };
    case "file":
      return { kind: "file", repo: target.repo, path: target.path, label: target.label };
  }
}

export function vizNotes(
  threads: readonly ReviewThread[],
  repoRoot: string,
  name: string,
): VizNote[] {
  const root = canonicalize(repoRoot);
  return threads.flatMap((thread) => {
    const diagram = thread.diagram;
    if (!diagram || diagram.viz !== name || canonicalize(thread.repoRoot) !== root) {
      return [];
    }
    const sentAt = thread.sentAt ?? "";
    const items = thread.items.map((item): VizNoteItem => {
      const who = item.kind === "reply" && item.author.kind === "agent" ? "agent" : "you";
      return {
        id: item.kind === "reply" ? item.id : thread.id,
        who,
        body: item.body,
        at: item.at,
        sent: who === "agent" || thread.delivery === "sent" || item.at <= sentAt,
      };
    });
    const readAt = diagram.readAt ?? "";
    const opening = thread.items[0];
    return [
      {
        id: thread.id,
        kind: opening.commentKind,
        title: diagram.title,
        body: opening.body,
        items,
        sent: thread.delivery === "sent",
        unread: items.filter((item) => item.who === "agent" && item.at > readAt).length,
        waiting: thread.delivery === "sent" && items[items.length - 1].who === "you",
        resolved: thread.resolvedAt !== undefined,
        targets: diagram.targets.map(noteTarget),
      },
    ];
  });
}

function codeOf(doc: VizDoc, target: VizNoteTarget): DiagramCode | undefined {
  const { viz } = doc;
  switch (target.kind) {
    case "node":
      return located(doc, viz.nodes.find((node) => node.id === target.id)?.files?.[0]);
    case "member": {
      const node = viz.nodes.find((candidate) => candidate.id === target.node);
      const member = node?.members?.find((candidate) => candidate.id === target.id);
      return located(doc, member?.file ?? node?.files?.[0]);
    }
    case "edge": {
      const edge = viz.edges?.find((candidate) => edgeId(candidate) === target.id);
      const from = edge && viz.nodes.find((node) => node.id === edge.from);
      return located(doc, edge?.files?.[0] ?? from?.files?.[0]);
    }
    case "step": {
      const step = viz.flows?.find((flow) => flow.id === target.flow)?.steps[target.index];
      const from = step && viz.nodes.find((node) => node.id === step.from);
      return located(doc, step?.files?.[0] ?? from?.files?.[0]);
    }
    case "file":
      return located(doc, {
        path: target.path,
        repo: target.repo === doc.meta.repoName ? undefined : target.repo,
      });
  }
}

function located(doc: VizDoc, ref: VizFileRef | undefined): DiagramCode | undefined {
  if (!ref) {
    return undefined;
  }
  const repoName = ref.repo ?? doc.meta.repoName;
  const repo = doc.meta.repos.find((candidate) => candidate.name === repoName);
  return repo
    ? { repoRoot: repo.root, path: ref.path, line: ref.line ?? 1, side: ref.side ?? "modified" }
    : undefined;
}
