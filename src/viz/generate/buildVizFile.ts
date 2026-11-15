import type { CompareTo } from "../../protocol/guidedReview.js";
import {
  VIZ_FILE_VERSION,
  VIZ_LIMITS,
  type VizDelta,
  type VizEdge,
  type VizFile,
  type VizFileRef,
  type VizLineCounts,
  type VizMember,
  type VizNode,
} from "../../protocol/viz.js";
import { plural } from "../model/render.js";
import type {
  ContextType,
  DefinitionHit,
  DiffedMember,
  DiffedType,
  GeneratedFileModel,
  LineCounts,
  MemberChange,
  SourceSpan,
  TypeChange,
  Visibility,
} from "./model.js";
import { buildRelations, contextSite, siteKey, typeGraph, type Relation } from "./relations.js";

export interface BuildVizInput {
  title?: string;
  compareTo: CompareTo;
  compareLabel: string;
  repoName: string;
  files: readonly GeneratedFileModel[];
  context?: readonly ContextType[];
  definitions?: readonly DefinitionHit[];
  unreadFiles?: number;
  generatedAt: string;
}

const MAX_ID = 240;
const ID_HASH = 8;

const TYPE_DELTA: Record<TypeChange, VizDelta> = {
  added: "added",
  removed: "removed",
  modified: "changed",
  unchanged: "unchanged",
};

const MEMBER_DELTA: Record<MemberChange, VizDelta> = {
  added: "added",
  removed: "removed",
  signature: "changed",
  body: "changed",
  unchanged: "unchanged",
};

const STATUS_DELTA: Record<GeneratedFileModel["status"], VizDelta> = {
  A: "added",
  D: "removed",
  M: "changed",
  R: "changed",
};

const VISIBILITY: Record<Visibility, NonNullable<VizMember["visibility"]>> = {
  "+": "public",
  "-": "private",
  "#": "protected",
  "~": "internal",
};

const RANK: Record<VizDelta, number> = { added: 0, removed: 0, changed: 0, unchanged: 1 };

const CONTEXT_RANK = 2;

interface Draft {
  node: VizNode;
  rank: number;
  memberIds: Map<string, string>;
}

class IdClaims {
  private readonly taken = new Set<string>();

  claim(raw: string): string {
    const base = raw.replace(/\s+/g, "_");
    let id = fitId(base);
    for (let n = 2; this.taken.has(id); n++) {
      id = fitId(`${base}~${n}`);
    }
    this.taken.add(id);
    return id;
  }
}

function fitId(id: string): string {
  if (id.length <= MAX_ID) {
    return id;
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
  }
  const suffix = (hash >>> 0).toString(36).padStart(ID_HASH, "0");
  return `${id.slice(0, MAX_ID - ID_HASH - 1)}~${suffix}`;
}

function clamp(text: string, max: number, fallback: string): string {
  const plain = text.replace(/\s+/g, " ").trim() || fallback;
  return plain.length <= max ? plain : `${plain.slice(0, max - 1).trimEnd()}…`;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

function countsOf(counts: LineCounts): VizLineCounts | undefined {
  return counts.added + counts.removed > 0 ? { ...counts } : undefined;
}

function changed(delta: VizDelta | undefined): boolean {
  return delta !== undefined && delta !== "unchanged";
}

function keepFirst<T>(items: readonly T[], limit: number, rank: (item: T) => number): T[] {
  if (items.length <= limit) {
    return [...items];
  }
  const kept = new Set(
    items
      .map((item, at) => ({ at, rank: rank(item) }))
      .sort((a, b) => a.rank - b.rank || a.at - b.at)
      .slice(0, limit)
      .map(({ at }) => at),
  );
  return items.filter((_, at) => kept.has(at));
}

export function buildVizFile(input: BuildVizInput): VizFile {
  const ids = new IdClaims();
  const context = input.context ?? [];
  const drafts: Draft[] = [];
  const nodeIdBySite = new Map<string, string>();

  const fileRef = (
    file: Pick<GeneratedFileModel, "repo" | "path" | "oldPath">,
    span?: SourceSpan,
  ): VizFileRef => ({
    path: span?.side === "base" ? (file.oldPath ?? file.path) : file.path,
    ...(span && { line: span.start + 1, endLine: span.end + 1, side: span.side }),
    ...(file.repo !== input.repoName && { repo: file.repo }),
  });

  const memberOf = (
    file: GeneratedFileModel,
    nodeId: string,
    member: DiffedMember,
    claimed: Map<string, string>,
  ): VizMember => {
    const id = ids.claim(`${nodeId}.${member.name || "member"}`);
    claimed.set(member.key, id);
    return {
      id,
      kind: member.kind,
      label: clamp(member.label, 200, member.name || "member"),
      short: clamp(member.short, 80, member.name || "member"),
      ...(member.previousLabel && { previous: clamp(member.previousLabel, 200, "member") }),
      ...(member.visibility && { visibility: VISIBILITY[member.visibility] }),
      ...(member.isStatic && { isStatic: true }),
      ...(member.isAbstract && { isAbstract: true }),
      delta: MEMBER_DELTA[member.change],
      ...((member.change === "signature" || member.change === "body") && {
        detail: member.change,
      }),
      ...(countsOf(member.counts) && { counts: countsOf(member.counts) }),
      file: fileRef(file, member.span),
    };
  };

  const typeDraft = (file: GeneratedFileModel, fileId: string, type: DiffedType): Draft => {
    const isModule = type.kind === "module";
    const id = ids.claim(isModule ? fileId : `${fileId}#${type.name}`);
    nodeIdBySite.set(siteKey({ repo: file.repo, path: file.path, type: type.key }), id);
    const memberIds = new Map<string, string>();
    const delta = TYPE_DELTA[type.change];
    const node: VizNode = {
      id,
      label: clamp(isModule ? baseName(file.path) : type.name, 80, "type"),
      kind: type.kind,
      delta,
      ...(type.isAbstract && { isAbstract: true }),
      ...(type.headerChanged && { detail: "signature" as const }),
      ...(countsOf(type.counts) && { counts: countsOf(type.counts) }),
      members: type.members.map((member) => memberOf(file, id, member, memberIds)),
      files: [fileRef(file, type.span)],
    };
    return { node, rank: RANK[delta], memberIds };
  };

  for (const file of input.files) {
    const fileId = `${file.repo}/${file.path}`;
    if (!file.types || file.types.length === 0) {
      const delta = STATUS_DELTA[file.status];
      const node: VizNode = {
        id: ids.claim(fileId),
        label: clamp(baseName(file.path), 80, "file"),
        kind: "file",
        delta,
        ...(countsOf(file.counts) && { counts: countsOf(file.counts) }),
        files: [
          {
            ...fileRef(file),
            ...(file.status === "D" && { side: "base" as const }),
          },
        ],
      };
      drafts.push({ node, rank: RANK[delta], memberIds: new Map() });
      continue;
    }
    for (const type of file.types) {
      drafts.push(typeDraft(file, fileId, type));
    }
  }

  for (const type of context) {
    const id = ids.claim(`${type.repo}/${type.path}#${type.name}`);
    nodeIdBySite.set(siteKey(contextSite(type)), id);
    drafts.push({
      node: {
        id,
        label: clamp(type.name, 80, "type"),
        kind: type.kind,
        delta: "unchanged",
        files: [{ ...fileRef(type), line: type.line + 1 }],
      },
      rank: CONTEXT_RANK,
      memberIds: new Map(),
    });
  }

  const keptDrafts = keepFirst(drafts, VIZ_LIMITS.nodes, (draft) => draft.rank);
  let droppedMembers = 0;
  const nodes = keptDrafts.map(({ node }) => {
    const members = node.members ?? [];
    if (members.length <= VIZ_LIMITS.members) {
      return node;
    }
    droppedMembers += members.length - VIZ_LIMITS.members;
    return {
      ...node,
      members: keepFirst(members, VIZ_LIMITS.members, (member) => (changed(member.delta) ? 0 : 1)),
    };
  });
  const keptNodes = new Set(nodes.map((node) => node.id));
  const keptMembers = new Set(nodes.flatMap((node) => (node.members ?? []).map((m) => m.id)));
  const memberIdsByNode = new Map(keptDrafts.map((draft) => [draft.node.id, draft.memberIds]));

  const edgeOf = (relation: Relation): VizEdge | undefined => {
    const from = nodeIdBySite.get(relation.source);
    const to = nodeIdBySite.get(relation.target);
    if (!from || !to || !keptNodes.has(from) || !keptNodes.has(to)) {
      return undefined;
    }
    const causes = relation.via.flatMap((key) => memberIdsByNode.get(from)?.get(key) ?? []);
    const via = causes.filter((id) => keptMembers.has(id));
    const single =
      (relation.kind === "association" || relation.kind === "dependency") &&
      causes.length === 1 &&
      via.length === 1;
    return {
      from,
      to,
      kind: relation.kind,
      delta: relation.change,
      ...(single && { fromMember: via[0] }),
      ...(via.length > 0 && { via }),
      ...(relation.multiplicity && { multiplicity: { to: relation.multiplicity } }),
    };
  };

  const allEdges = buildRelations(typeGraph(input.files, context), input.definitions ?? []).flatMap(
    (relation) => edgeOf(relation) ?? [],
  );
  const edges = keepFirst(allEdges, VIZ_LIMITS.edges, (edge) => RANK[edge.delta]);

  return {
    version: VIZ_FILE_VERSION,
    title: clamp(
      input.title ?? (input.compareLabel ? `Changes vs ${input.compareLabel}` : "Changes"),
      80,
      "Changes",
    ),
    summary: summaryOf(input, {
      droppedNodes: drafts.length - nodes.length,
      droppedMembers,
      droppedEdges: allEdges.length - edges.length,
    }),
    base: "changes",
    compareTo: input.compareTo,
    generatedAt: input.generatedAt,
    nodes,
    edges,
  };
}

interface Dropped {
  droppedNodes: number;
  droppedMembers: number;
  droppedEdges: number;
}

function summaryOf(input: BuildVizInput, shown: Dropped): string {
  const total = input.files.length + (input.unreadFiles ?? 0);
  if (total === 0) {
    return clamp(
      `No changed files vs ${input.compareLabel || "the Compare To"}.`,
      600,
      "No changes.",
    );
  }
  const types = input.files.flatMap((file) =>
    (file.types ?? []).filter((type) => type.kind !== "module" && type.change !== "unchanged"),
  );
  const added = input.files.reduce((sum, file) => sum + file.counts.added, 0);
  const removed = input.files.reduce((sum, file) => sum + file.counts.removed, 0);
  const noOutline = input.files.filter((file) => !file.types || file.types.length === 0).length;
  const sentences = [
    `${plural(types.length, "changed type")} in ${plural(total, "changed file")}, +${added}/-${removed}.`,
  ];
  if (noOutline > 0) {
    sentences.push(
      `${plural(noOutline, "file")} without class or function symbols ${noOutline === 1 ? "shows" : "show"} as a file box.`,
    );
  }
  if (input.unreadFiles) {
    sentences.push(
      `Only the first ${input.files.length} changed files were read, ${input.unreadFiles} were not.`,
    );
  }
  if (shown.droppedNodes > 0) {
    sentences.push(
      `Dropped ${plural(shown.droppedNodes, "node")}, unchanged first, to stay within ${VIZ_LIMITS.nodes}.`,
    );
  }
  if (shown.droppedMembers > 0) {
    sentences.push(
      `Dropped ${plural(shown.droppedMembers, "member")}, unchanged first, from boxes with more than ${VIZ_LIMITS.members}.`,
    );
  }
  if (shown.droppedEdges > 0) {
    sentences.push(
      `Dropped ${plural(shown.droppedEdges, "link")}, unchanged first, to stay within ${VIZ_LIMITS.edges}.`,
    );
  }
  return clamp(sentences.join(" "), 600, "Changes.");
}
