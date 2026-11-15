import * as fs from "node:fs";
import * as path from "node:path";

import type { VizFile } from "../../protocol/viz.js";
import type { VizRepo } from "../model/types.js";
import type { VizListEntry } from "../protocol.js";

export const VIZ_SUFFIX = ".viz.json";

const VIZ_DIR = path.join(".paireto", "viz");

export interface VizFileEntry {
  name: string;
  path: string;
  repoRoot: string;
  repoName: string;
  title: string;
  modifiedAt: number;
}

export function vizDirOf(repoRoot: string): string {
  return path.join(repoRoot, VIZ_DIR);
}

export function vizPathOf(repoRoot: string, name: string): string {
  return path.join(vizDirOf(repoRoot), `${name}${VIZ_SUFFIX}`);
}

export function vizNameOf(file: string): string {
  return path.basename(file).slice(0, -VIZ_SUFFIX.length);
}

export function repoRootOfViz(file: string): string {
  return path.dirname(path.dirname(path.dirname(file)));
}

export function listVizFiles(repos: readonly VizRepo[]): VizFileEntry[] {
  return repos
    .flatMap((repo) =>
      readDir(vizDirOf(repo.root))
        .filter((entry) => entry.endsWith(VIZ_SUFFIX))
        .flatMap((entry) => {
          const file = path.join(vizDirOf(repo.root), entry);
          const modifiedAt = mtimeOf(file);
          return modifiedAt === undefined
            ? []
            : [
                {
                  name: vizNameOf(file),
                  path: file,
                  repoRoot: repo.root,
                  repoName: repo.name,
                  title: titleOf(file) ?? vizNameOf(file),
                  modifiedAt,
                },
              ];
        }),
    )
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function listEntries(files: readonly VizFileEntry[]): VizListEntry[] {
  return files.map((file) => ({
    name: file.name,
    title: file.title,
    repoName: file.repoName,
    modifiedAt: new Date(file.modifiedAt).toISOString(),
  }));
}

export function writeVizFile(file: string, viz: VizFile): { replaced: boolean } {
  const replaced = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(viz, null, 2)}\n`);
  return { replaced };
}

function titleOf(file: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const title =
      typeof parsed === "object" && parsed !== null && "title" in parsed ? parsed.title : undefined;
    return typeof title === "string" && title.trim() ? title.trim() : undefined;
  } catch {
    return undefined;
  }
}

function mtimeOf(file: string): number | undefined {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
}

function readDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
