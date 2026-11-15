import type { VizFileRef, VizMember, VizNode } from "../../protocol/viz.js";
import type { VizReviewFile, VizReviewState } from "../protocol.js";
import type { VizIndex } from "./index.js";
import type { VizRef } from "./types.js";
import { changeSize } from "./visible.js";

export function fileKey(file: { readonly repo?: string; readonly path: string }): string {
  return file.repo ? `${file.repo}:${file.path}` : file.path;
}

function refMatches(ref: VizFileRef | undefined, file: VizReviewFile): boolean {
  return (
    ref !== undefined &&
    ref.path === file.path &&
    (ref.repo === undefined || ref.repo === file.repo)
  );
}

export function fileOfNode(
  files: readonly VizReviewFile[],
  node: VizNode,
): VizReviewFile | undefined {
  return files.find((file) => refMatches(node.files?.[0], file));
}

export interface ReviewMarks {
  readonly seen: ReadonlySet<string>;
  readonly threads: ReadonlyMap<string, number>;
}

export const NO_MARKS: ReviewMarks = { seen: new Set(), threads: new Map() };

export function reviewMarks(index: VizIndex, review: VizReviewState): ReviewMarks {
  const seen = new Set<string>();
  for (const file of review.files) {
    if (file.seen) {
      for (const node of index.nodes) {
        if (refMatches(node.files?.[0], file)) {
          seen.add(node.id);
        }
      }
    }
  }
  const threads = new Map<string, number>();
  for (const note of review.notes) {
    if (note.resolved) {
      continue;
    }
    for (const target of note.targets) {
      const node =
        target.kind === "node" ? target.id : target.kind === "member" ? target.node : undefined;
      if (node !== undefined) {
        threads.set(node, (threads.get(node) ?? 0) + 1);
      }
    }
  }
  return { seen, threads };
}

export interface FileEntry {
  readonly file: VizReviewFile;
  readonly nodes: readonly { readonly node: VizNode; readonly members: readonly VizMember[] }[];
}

function changedMembers(node: VizNode): VizMember[] {
  return (node.members ?? [])
    .filter((member) => (member.delta ?? "unchanged") !== "unchanged")
    .sort((a, b) => changeSize(b) - changeSize(a));
}

function rankedNodes(index: VizIndex): VizNode[] {
  return index.overviewNodes
    .filter((node) => node.delta !== "unchanged")
    .sort((a, b) => changeSize(b) - changeSize(a) || a.label.localeCompare(b.label));
}

export function reviewFiles(index: VizIndex, files: readonly VizReviewFile[]): FileEntry[] {
  const ranked = rankedNodes(index);
  return files.map((file) => ({
    file,
    nodes: ranked
      .filter((node) => refMatches(node.files?.[0], file))
      .map((node) => ({ node, members: changedMembers(node) })),
  }));
}

export interface ChangeCursor {
  readonly file: string;
  readonly index: number;
}

export interface ChangeStop {
  readonly cursor: ChangeCursor;
  readonly count: number;
  readonly ref: VizRef;
}

export interface ChangeStep {
  readonly stop?: ChangeStop;
  readonly seen?: VizReviewFile;
}

export interface ChangeFrom {
  readonly cursor?: ChangeCursor;
  readonly selection?: VizRef;
}

export function nextChange(
  index: VizIndex,
  files: readonly VizReviewFile[],
  from: ChangeFrom,
): ChangeStep {
  const entries = reviewFiles(index, files);
  const byKey = new Map(entries.map((entry) => [fileKey(entry.file), entry] as const));
  const spotsIn = (key: string): VizRef[] =>
    (byKey.get(key)?.nodes ?? []).flatMap(({ node, members }) =>
      members.length > 0
        ? members.map((member): VizRef => ({ kind: "member", id: member.id, node: node.id }))
        : [{ kind: "node", id: node.id } satisfies VizRef],
    );
  const stopAt = (key: string, at: number): ChangeStop | undefined => {
    const spots = spotsIn(key);
    const ref = spots[at];
    return ref ? { cursor: { file: key, index: at }, count: spots.length, ref } : undefined;
  };
  const moveOn = (seenKey: string | undefined): ChangeStep => {
    const next = entries.find(
      (entry) => fileKey(entry.file) !== seenKey && !entry.file.seen && entry.nodes.length > 0,
    );
    const seen = seenKey === undefined ? undefined : byKey.get(seenKey)?.file;
    return { seen, stop: next ? stopAt(fileKey(next.file), 0) : undefined };
  };
  const selectedNode =
    from.selection?.kind === "node"
      ? from.selection.id
      : from.selection?.kind === "member"
        ? from.selection.node
        : undefined;
  const picked =
    selectedNode === undefined
      ? undefined
      : entries.find((entry) => entry.nodes.some(({ node }) => node.id === selectedNode));
  const pickedKey = picked ? fileKey(picked.file) : undefined;
  const pickedStart = (): number | undefined => {
    if (!pickedKey || !from.selection) {
      return undefined;
    }
    const spots = spotsIn(pickedKey);
    const selection = from.selection;
    const exact = spots.findIndex(
      (spot) =>
        (spot.kind === "member" && selection.kind === "member" && spot.id === selection.id) ||
        (spot.kind === "node" && spot.id === selectedNode),
    );
    const index =
      exact >= 0
        ? exact
        : spots.findIndex((spot) => spot.kind === "member" && spot.node === selectedNode);
    return index >= 0 ? index : undefined;
  };
  const cursor = from.cursor;
  if (cursor && (!pickedKey || pickedKey === cursor.file)) {
    const start = pickedStart();
    if (start !== undefined && start > cursor.index) {
      return { stop: stopAt(cursor.file, start) };
    }
    const count = spotsIn(cursor.file).length;
    return cursor.index + 1 < count
      ? { stop: stopAt(cursor.file, cursor.index + 1) }
      : moveOn(cursor.file);
  }
  if (pickedKey) {
    const start = pickedStart();
    return start !== undefined ? { stop: stopAt(pickedKey, start) } : moveOn(pickedKey);
  }
  return moveOn(undefined);
}

export function seenProgress(files: readonly VizReviewFile[]): { seen: number; total: number } {
  return { seen: files.filter((file) => file.seen).length, total: files.length };
}
