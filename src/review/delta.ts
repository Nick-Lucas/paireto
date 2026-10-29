import type { FileStatus, NetChange } from "../git/DiffService.js";
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
  const rowPath = renameTargets(changes);
  const layersByPath = new Map<string, RepoChangedFile[]>();
  for (const group of LAYER_ORDER) {
    for (const file of changes[group]) {
      const key = rowPath(file.path);
      layersByPath.set(key, [...(layersByPath.get(key) ?? []), file]);
    }
  }
  const netByPath = new Map<string, NetChange[]>();
  for (const net of changes.net) {
    const key = rowPath(net.path);
    netByPath.set(key, [...(netByPath.get(key) ?? []), net]);
  }
  const base = changes.compareRef ?? "HEAD";
  const rows: DeltaFile[] = [];
  for (const [path, nets] of netByPath) {
    const layers = layersByPath.get(path);
    if (!layers) {
      continue;
    }
    layersByPath.delete(path);
    const own = nets.find((net) => net.path === path);
    const moved = nets.find((net) => net.path !== path);
    const main = own ?? nets[0];
    rows.push({
      repoRoot,
      path,
      oldPath: own?.oldPath ?? moved?.path,
      status: layers.some((layer) => layer.status === "!") ? "!" : own && moved ? "R" : main.status,
      additions: nets.reduce((sum, net) => sum + net.additions, 0),
      deletions: nets.reduce((sum, net) => sum + net.deletions, 0),
      contentId: main.contentId && `${base}:${main.contentId}`,
      stage: stageState(layers),
      layers,
    });
  }
  for (const [path, layers] of layersByPath) {
    rows.push({
      repoRoot,
      path,
      oldPath: layers.find((layer) => layer.oldPath !== undefined)?.oldPath,
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

function renameTargets(changes: RepositoryChangesModel): (path: string) => string {
  const livePaths = new Set(changes.net.filter((net) => net.status !== "D").map((net) => net.path));
  const renamedTo = new Map<string, string>();
  for (const entry of [...LAYER_ORDER.flatMap((group) => changes[group]), ...changes.net]) {
    if (entry.oldPath !== undefined && !livePaths.has(entry.oldPath)) {
      renamedTo.set(entry.oldPath, entry.path);
    }
  }
  return (path) => {
    const visited = new Set([path]);
    let current = path;
    let next = renamedTo.get(current);
    while (next !== undefined && !visited.has(next)) {
      visited.add(next);
      current = next;
      next = renamedTo.get(current);
    }
    return current;
  };
}

export function stagingFlags(files: DeltaFile[]): string {
  const layers = files.flatMap((file) => file.layers);
  const stage = layers.some((layer) => layer.group === "unstaged") ? ":stage" : "";
  const unstage = layers.some((layer) => layer.group === "staged") ? ":unstage" : "";
  return `${stage}${unstage}`;
}
