import type { VizNode } from "../../protocol/viz.js";
import type { VizIndex } from "../model/index.js";
import { changeSize, componentOf, folderOf, type Grouping } from "../model/visible.js";

export interface AutoGroup {
  readonly id: string;
  readonly title: string;
  readonly members: readonly string[];
}

export function topLevelOf(index: VizIndex, id: string): string {
  let at = index.nodeById.get(id);
  while (at?.parent !== undefined && index.nodeById.has(at.parent)) {
    at = index.nodeById.get(at.parent);
  }
  return at?.id ?? id;
}

function roots(index: VizIndex): VizNode[] {
  return index.overviewNodes.filter(
    (node) => node.parent === undefined || !index.nodeById.has(node.parent),
  );
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function byLinks(index: VizIndex, nodes: readonly VizNode[]): AutoGroup[] {
  const parent = new Map(nodes.map((node) => [node.id, node.id]));
  const find = (id: string): string => {
    let at = id;
    while (parent.get(at) !== at) {
      at = parent.get(at)!;
    }
    return at;
  };
  for (const edge of index.edges) {
    const from = topLevelOf(index, edge.from);
    const to = topLevelOf(index, edge.to);
    if (parent.has(from) && parent.has(to)) {
      parent.set(find(from), find(to));
    }
  }
  const members = new Map<string, VizNode[]>();
  for (const node of nodes) {
    const key = find(node.id);
    members.set(key, [...(members.get(key) ?? []), node]);
  }
  return [...members.values()]
    .filter((list) => list.length > 1)
    .map((list) => {
      const largest = [...list].sort((a, b) => changeSize(b) - changeSize(a))[0];
      const typesOnly = list.every((node) => componentOf(index, node) === "classBox");
      return {
        list,
        size: list.reduce((sum, node) => sum + changeSize(node), 0),
        title: `${largest.label} and ${plural(list.length - 1, typesOnly ? "linked type" : "linked part")}`,
      };
    })
    .sort(
      (a, b) => b.size - a.size || b.list.length - a.list.length || a.title.localeCompare(b.title),
    )
    .map((group, i) => ({
      id: `links/${i}`,
      title: group.title,
      members: group.list.map((node) => node.id),
    }));
}

function byFolders(nodes: readonly VizNode[]): AutoGroup[] {
  const members = new Map<string, VizNode[]>();
  for (const node of nodes) {
    const folder = folderOf(node);
    if (folder !== undefined) {
      members.set(folder, [...(members.get(folder) ?? []), node]);
    }
  }
  return [...members.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, list], i) => ({
      id: `folder/${i}`,
      title: folder,
      members: list.map((node) => node.id),
    }));
}

export function autoGroups(index: VizIndex, grouping: Grouping): AutoGroup[] {
  const nodes = roots(index);
  return grouping === "links" ? byLinks(index, nodes) : byFolders(nodes);
}
