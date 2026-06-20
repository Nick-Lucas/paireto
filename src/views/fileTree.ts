// Builds a folder hierarchy from a flat list of changed files for the tree layout, compressing
// single-child folder chains the way the native git/explorer tree does (e.g. "src/review").
// Pure + dependency-free so it's unit-testable.

import type { ChangedFile } from "../git/DiffService.js";

export type TreeEntry =
  | { type: "folder"; name: string; path: string; children: TreeEntry[] }
  | { type: "file"; file: ChangedFile };

interface MutFolder {
  folders: Map<string, MutFolder>;
  files: ChangedFile[];
}

function emptyFolder(): MutFolder {
  return { folders: new Map(), files: [] };
}

export function buildFileTree(files: ChangedFile[]): TreeEntry[] {
  const root = emptyFolder();
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
export function filesInEntry(entry: TreeEntry): ChangedFile[] {
  if (entry.type === "file") {
    return [entry.file];
  }
  return entry.children.flatMap(filesInEntry);
}

function toEntries(node: MutFolder, prefix: string): TreeEntry[] {
  const folders: TreeEntry[] = [];
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
  const fileEntries: TreeEntry[] = node.files
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({ type: "file", file }));
  return [...folders, ...fileEntries];
}
