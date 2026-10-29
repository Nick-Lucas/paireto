import type { FileStatus } from "../git/DiffService.js";
import type { FileGroup } from "../types.js";
import type { RepoChangedFile, RepositoryChangesModel } from "./ReviewController.js";

export type StageState = "unstaged" | "partial" | "staged" | "committed";

export interface DeltaFile {
  repoRoot: string;
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  contentId: string;
  stage: StageState;
  layers: RepoChangedFile[];
}

const LAYER_ORDER: FileGroup[] = ["unstaged", "staged", "committed"];

export function stageState(layers: RepoChangedFile[]): StageState {
  const has = (group: FileGroup): boolean => layers.some((layer) => layer.group === group);
  if (has("unstaged")) {
    return has("staged") ? "partial" : "unstaged";
  }
  return has("staged") ? "staged" : "committed";
}

export function buildDelta(repoRoot: string, changes: RepositoryChangesModel): DeltaFile[] {
  const layersByPath = new Map<string, RepoChangedFile[]>();
  for (const group of LAYER_ORDER) {
    for (const file of changes[group]) {
      layersByPath.set(file.path, [...(layersByPath.get(file.path) ?? []), file]);
    }
  }
  const base = changes.compareRef ?? "HEAD";
  const rows: DeltaFile[] = [];
  for (const net of changes.net) {
    const layers = layersByPath.get(net.path);
    if (!layers) {
      continue;
    }
    layersByPath.delete(net.path);
    rows.push({
      repoRoot,
      path: net.path,
      oldPath: net.oldPath,
      status: layers.some((layer) => layer.status === "!") ? "!" : net.status,
      additions: net.additions,
      deletions: net.deletions,
      contentId: net.contentId && `${base}:${net.contentId}`,
      stage: stageState(layers),
      layers,
    });
  }
  for (const [path, layers] of layersByPath) {
    rows.push({
      repoRoot,
      path,
      oldPath: layers[0].oldPath,
      status: layers[0].status,
      additions: 0,
      deletions: 0,
      contentId: `${base}:unchanged:${layers.map((layer) => layer.group).join(",")}`,
      stage: stageState(layers),
      layers,
    });
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export function deletedFromDisk(changes: Pick<RepositoryChangesModel, FileGroup>): Set<string> {
  const newest = new Map<string, RepoChangedFile>();
  for (const group of LAYER_ORDER) {
    for (const file of changes[group]) {
      if (!newest.has(file.path)) {
        newest.set(file.path, file);
      }
    }
  }
  return new Set(
    [...newest.values()].filter((file) => file.status === "D").map((file) => file.path),
  );
}

export function stagingFlags(files: DeltaFile[]): string {
  const layers = files.flatMap((file) => file.layers);
  const stage = layers.some((layer) => layer.group === "unstaged") ? ":stage" : "";
  const unstage = layers.some((layer) => layer.group === "staged") ? ":unstage" : "";
  return `${stage}${unstage}`;
}
