// Builds a folder hierarchy from a flat list of changed files for the tree layout, compressing
// single-child folder chains the way the native git/explorer tree does (e.g. "src/review").
// Pure + dependency-free so it's unit-testable.

import type { ChangedFile } from "../git/DiffService.js";

export type TreeEntry<F extends { path: string } = ChangedFile> =
  | { type: "folder"; name: string; path: string; children: TreeEntry<F>[] }
  | { type: "file"; file: F };

interface MutFolder<F> {
  folders: Map<string, MutFolder<F>>;
  files: F[];
}

function emptyFolder<F>(): MutFolder<F> {
  return { folders: new Map(), files: [] };
}

export function buildFileTree<F extends { path: string }>(files: F[]): TreeEntry<F>[] {
  const root = emptyFolder<F>();
  for (const file of files) {
    const parts = file.path.split("/");
    parts.pop(); // drop the file name; keep only folder segments
    let node = root;
    for (const part of parts) {
      let next = node.folders.get(part);
      if (!next) {
        next = emptyFolder();
        node.folders.set(part, next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return toEntries(root, "");
}

/** All files at or below an entry — used to stage/unstage/discard a whole folder at once. */
export function filesInEntry<F extends { path: string }>(entry: TreeEntry<F>): F[] {
  if (entry.type === "file") {
    return [entry.file];
  }
  return entry.children.flatMap(filesInEntry);
}

function toEntries<F extends { path: string }>(node: MutFolder<F>, prefix: string): TreeEntry<F>[] {
  const folders: TreeEntry<F>[] = [];
  for (const [name, child] of [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let label = name;
    let folder = child;
    let path = prefix ? `${prefix}/${name}` : name;
    // Compress chains of single-subfolder, no-file folders: a → a/b → a/b/c.
    while (folder.files.length === 0 && folder.folders.size === 1) {
      const [childName, grandchild] = [...folder.folders.entries()][0];
      label = `${label}/${childName}`;
      path = `${path}/${childName}`;
      folder = grandchild;
    }
    folders.push({ type: "folder", name: label, path, children: toEntries(folder, path) });
  }
  const fileEntries: TreeEntry<F>[] = node.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({ type: "file", file }));
  return [...folders, ...fileEntries];
}

export function sortByDirectory<F extends { path: string }>(files: F[]): F[] {
  const split = (file: F): [string, string] => {
    const slash = file.path.lastIndexOf("/");
    return [file.path.slice(0, Math.max(slash, 0)), file.path.slice(slash + 1)];
  };
  return files.slice().sort((a, b) => {
    const [aDir, aName] = split(a);
    const [bDir, bName] = split(b);
    return aDir.localeCompare(bDir) || aName.localeCompare(bName);
  });
}
