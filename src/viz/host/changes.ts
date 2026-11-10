import type { FileStatus } from "../../git/DiffService.js";
import type { CompareTo } from "../../protocol/guidedReview.js";
import type { ChangedFileStatus, VizChangedFile } from "../model/types.js";

export const UNIT_MANIFESTS = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
  "Dockerfile",
];

const MAX_FILE_ROWS = 300;

export interface RepoChanges {
  name: string;
  isCaller: boolean;
  compareTo: CompareTo;
  compareLabel: string;
  files: VizChangedFile[];
}

export interface ChangeUnit {
  repo: string;
  dir: string;
  manifest?: string;
  files: number;
}

export type VizLevel = "service" | "component";

const STATUS: Record<FileStatus, ChangedFileStatus> = {
  A: "A",
  M: "M",
  D: "D",
  R: "R",
  C: "A",
  U: "M",
  "!": "M",
};

export function vizStatus(status: FileStatus): ChangedFileStatus {
  return STATUS[status];
}

export function manifestIn(entries: string[]): string | undefined {
  return (
    UNIT_MANIFESTS.find((manifest) => entries.includes(manifest)) ??
    entries.find((entry) => entry.endsWith(".csproj"))
  );
}

export function findUnits(
  repo: string,
  files: VizChangedFile[],
  manifestAt: (dir: string) => string | undefined,
): ChangeUnit[] {
  const units = new Map<string, ChangeUnit>();
  for (const file of files) {
    const segments = file.path.split("/").slice(0, -1);
    let unit: ChangeUnit = { repo, dir: "", files: 0 };
    for (let depth = segments.length; depth >= 0; depth--) {
      const dir = segments.slice(0, depth).join("/");
      const manifest = manifestAt(dir);
      if (manifest) {
        unit = { repo, dir, manifest, files: 0 };
        break;
      }
    }
    const existing = units.get(unit.dir) ?? unit;
    existing.files += 1;
    units.set(unit.dir, existing);
  }
  return [...units.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

export function levelHint(repos: RepoChanges[], units: ChangeUnit[]): VizLevel {
  const changedRepos = repos.filter((repo) => repo.files.length > 0).length;
  return changedRepos >= 2 || units.length >= 2 ? "service" : "component";
}

export function renderChanges(repos: RepoChanges[], units: ChangeUnit[]): string {
  const lines: string[] = [];
  let rows = 0;
  let hidden = 0;
  for (const repo of repos) {
    const added = repo.files.reduce((sum, file) => sum + file.additions, 0);
    const removed = repo.files.reduce((sum, file) => sum + file.deletions, 0);
    const who = repo.isCaller
      ? "this repo, omit repo on file refs"
      : `file refs use repo "${repo.name}"`;
    lines.push(
      `Repo ${repo.name} (${who}). Compare To: ${repo.compareLabel} [${compareToText(repo.compareTo)}]. ` +
        `${repo.files.length} changed ${repo.files.length === 1 ? "file" : "files"}, +${added} -${removed}.`,
    );
    const repoUnits = units.filter((unit) => unit.repo === repo.name);
    if (repoUnits.length > 0) {
      lines.push(`Units: ${repoUnits.map(unitText).join(", ")}`);
    }
    for (const file of repo.files) {
      if (rows >= MAX_FILE_ROWS) {
        hidden += 1;
        continue;
      }
      rows += 1;
      lines.push(`  ${file.status} ${file.path} +${file.additions} -${file.deletions}`);
    }
  }
  if (hidden > 0) {
    lines.push(`  +${hidden} more`);
  }
  const level = levelHint(repos, units);
  lines.push(
    `Level hint: ${level} (${units.length} ${units.length === 1 ? "unit" : "units"} changed).`,
    "Read these diffs against the Compare To above, then call paireto_show_viz.",
  );
  return lines.join("\n");
}

function unitText(unit: ChangeUnit): string {
  const dir = unit.dir || "(repo root)";
  return unit.manifest ? `${dir} [${unit.manifest}] ${unit.files}` : `${dir} ${unit.files}`;
}

function compareToText(compareTo: CompareTo): string {
  return compareTo.kind === "ref" && compareTo.ref ? `ref ${compareTo.ref}` : compareTo.kind;
}
