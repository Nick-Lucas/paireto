import * as path from "node:path";

import type { CompareTo } from "../../protocol/guidedReview.js";
import type { VizFile } from "../../protocol/viz.js";
import type { VizRepo } from "../model/types.js";
import type { VizFileStatus } from "../protocol.js";
import { buildVizFile } from "./buildVizFile.js";
import { diffFile } from "./fileDiff.js";
import { diffLines } from "./lineDiff.js";
import type {
  ContextKind,
  ContextType,
  DefinitionHit,
  DefinitionQuery,
  DiffSide,
  GeneratedFileModel,
  RepoLine,
} from "./model.js";
import { extractOutline, type OutlineSymbol } from "./outline.js";
import { definitionQueries, typeGraph, unresolvedNames } from "./relations.js";
import { findWord } from "./signature.js";

export const GENERATE_LIMITS = {
  files: 250,
  lines: 20000,
  contextLookups: 25,
  definitionLookups: 40,
  concurrency: 4,
} as const;

const NON_CODE_LANGUAGES = new Set([
  "csv",
  "css",
  "diff",
  "dotenv",
  "git-commit",
  "html",
  "ignore",
  "ini",
  "json",
  "jsonc",
  "jsonl",
  "less",
  "log",
  "markdown",
  "plaintext",
  "properties",
  "scss",
  "svg",
  "toml",
  "xml",
  "yaml",
]);

export interface ChangedSource {
  repo: string;
  path: string;
  oldPath?: string;
  status: VizFileStatus;
  additions: number;
  deletions: number;
}

export interface SourceText {
  lines: string[];
  languageId: string;
}

export interface SourceLocation {
  fsPath: string;
  line: number;
}

export interface TypeSymbol extends SourceLocation {
  kind: ContextKind;
}

export interface GenerateScope<F extends ChangedSource> {
  repoName: string;
  compareTo: CompareTo;
  compareLabel: string;
  repos: VizRepo[];
  files: F[];
}

export interface GenerateDeps<F extends ChangedSource> {
  scope(repoRoot: string): GenerateScope<F>;
  read(file: F, side: DiffSide): Promise<SourceText | undefined>;
  symbols(file: F, side: DiffSide, text: SourceText): Promise<OutlineSymbol[] | undefined>;
  symbolsFromCopy(file: F, text: SourceText): Promise<OutlineSymbol[] | undefined>;
  findType(name: string): Promise<TypeSymbol | undefined>;
  definition(file: F, line: number, character: number): Promise<SourceLocation | undefined>;
  progress?(message: string): void;
}

export interface GenerateRequest {
  repoRoot: string;
  title?: string;
}

interface ReadFile<F> {
  source: F;
  model: GeneratedFileModel;
  lines?: string[];
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function hasCode(lines: readonly string[]): boolean {
  return lines.some((line) => line.trim() !== "");
}

function locate(repos: readonly VizRepo[], location: SourceLocation): RepoLine | undefined {
  const matches = repos.flatMap((repo) => {
    const relative = path.relative(repo.root, location.fsPath);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
      ? [{ repo, relative }]
      : [];
  });
  const best = matches.sort((a, b) => b.repo.root.length - a.repo.root.length)[0];
  return (
    best && {
      repo: best.repo.name,
      path: best.relative.split(path.sep).join("/"),
      line: location.line,
    }
  );
}

async function readFile<F extends ChangedSource>(
  file: F,
  deps: GenerateDeps<F>,
): Promise<ReadFile<F>> {
  const [base, modified] = await Promise.all([
    file.status === "A" ? undefined : deps.read(file, "base"),
    file.status === "D" ? undefined : deps.read(file, "modified"),
  ]);
  const diff = diffLines(base?.lines ?? [], modified?.lines ?? []);
  const gitCounts = file.additions + file.deletions > 0;
  const model: GeneratedFileModel = {
    repo: file.repo,
    path: file.path,
    ...(file.oldPath !== undefined && { oldPath: file.oldPath }),
    status: file.status,
    counts: gitCounts
      ? { added: file.additions, removed: file.deletions }
      : { added: diff.added.size, removed: diff.removed.size },
  };
  const languageId = modified?.languageId ?? base?.languageId ?? "plaintext";
  const tooLong =
    Math.max(base?.lines.length ?? 0, modified?.lines.length ?? 0) > GENERATE_LIMITS.lines;
  if (NON_CODE_LANGUAGES.has(languageId) || tooLong || (!base && !modified)) {
    return { source: file, model };
  }
  const [directBase, modifiedSymbols] = await Promise.all([
    base ? deps.symbols(file, "base", base) : undefined,
    modified ? deps.symbols(file, "modified", modified) : undefined,
  ]);
  const modifiedTypes =
    modified && modifiedSymbols ? extractOutline(modifiedSymbols, modified.lines) : undefined;
  let baseTypes = base && directBase ? extractOutline(directBase, base.lines) : undefined;
  if (
    base &&
    hasCode(base.lines) &&
    (baseTypes === undefined || (baseTypes.length === 0 && (modifiedTypes?.length ?? 0) > 0))
  ) {
    const copied = await deps.symbolsFromCopy(file, base);
    baseTypes = copied ? extractOutline(copied, base.lines) : baseTypes;
  }
  const missing = (!!base && !baseTypes) || (!!modified && !modifiedTypes);
  if (missing || (baseTypes?.length ?? 0) + (modifiedTypes?.length ?? 0) === 0) {
    return { source: file, model };
  }
  return {
    source: file,
    model: { ...model, types: diffFile(baseTypes ?? [], modifiedTypes ?? [], diff) },
    lines: modified?.lines,
  };
}

async function findContext<F extends ChangedSource>(
  names: readonly string[],
  scope: GenerateScope<F>,
  deps: GenerateDeps<F>,
): Promise<ContextType[]> {
  const found = await mapLimited(names, GENERATE_LIMITS.concurrency, async (name) => {
    const symbol = await deps.findType(name);
    const at = symbol && locate(scope.repos, symbol);
    return at && symbol ? [{ ...at, name, kind: symbol.kind }] : [];
  });
  return found.flat();
}

async function findDefinitions<F extends ChangedSource>(
  queries: readonly DefinitionQuery[],
  read: readonly ReadFile<F>[],
  scope: GenerateScope<F>,
  deps: GenerateDeps<F>,
): Promise<DefinitionHit[]> {
  const byFile = new Map(read.map((file) => [`${file.model.repo}\n${file.model.path}`, file]));
  const hits = await mapLimited(queries, GENERATE_LIMITS.concurrency, async (query) => {
    const file = byFile.get(`${query.from.repo}\n${query.from.path}`);
    if (!file?.lines) {
      return [];
    }
    for (let line = query.line; line <= query.endLine; line++) {
      const character = findWord(file.lines[line] ?? "", query.name);
      if (character < 0) {
        continue;
      }
      const location = await deps.definition(file.source, line, character);
      const target = location && locate(scope.repos, location);
      return target ? [{ from: query.from, name: query.name, target }] : [];
    }
    return [];
  });
  return hits.flat();
}

export async function generateViz<F extends ChangedSource>(
  request: GenerateRequest,
  deps: GenerateDeps<F>,
): Promise<VizFile> {
  const progress = deps.progress ?? (() => undefined);
  const scope = deps.scope(request.repoRoot);
  const work = scope.files.slice(0, GENERATE_LIMITS.files);
  let done = 0;
  const read = await mapLimited(work, GENERATE_LIMITS.concurrency, async (file) => {
    const result = await readFile(file, deps);
    done++;
    progress(`Reading symbols… ${done}/${work.length} files`);
    return result;
  });
  const files = read.map((file) => file.model);

  progress("Finding related types…");
  const names = unresolvedNames(typeGraph(files, []), GENERATE_LIMITS.contextLookups);
  const context = await findContext(names, scope, deps);
  const queries = definitionQueries(typeGraph(files, context), GENERATE_LIMITS.definitionLookups);
  const definitions = await findDefinitions(queries, read, scope, deps);

  return buildVizFile({
    title: request.title,
    compareTo: scope.compareTo,
    compareLabel: scope.compareLabel,
    repoName: scope.repoName,
    files,
    context,
    definitions,
    unreadFiles: scope.files.length - work.length,
    generatedAt: new Date().toISOString(),
  });
}
