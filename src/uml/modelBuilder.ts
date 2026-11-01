import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { log } from "../log.js";
import { buildDelta, type DeltaFile } from "../review/delta.js";
import type { ReviewController } from "../review/ReviewController.js";
import { ReviewPath } from "../review/ReviewPath.js";
import type { SeenFiles } from "../review/SeenFiles.js";
import { diffFile, fileType, type DiffedType, type ThreadPosition } from "./core/fileDiff.js";
import { diffHunks, diffLines, splitLines, type LineDiff } from "./core/lineDiff.js";
import type { TypeChange, TypeKind, UmlFile, UmlModel, UmlType } from "./core/model.js";
import { extractOutline, type OutlineType } from "./core/outline.js";
import { buildRelations, unresolvedNames } from "./core/relations.js";
import { documentSymbols, findTypeDefinition } from "./symbols.js";

const MAX_FILES = 250;
const MAX_LINES = 20000;
const MAX_CONTEXT_LOOKUPS = 25;
const CONCURRENCY = 4;

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

interface SideAnalysis {
  lineCount: number;
  types: OutlineType[];
}

interface FileAnalysis {
  contentKey: string;
  base?: SideAnalysis;
  modified?: SideAnalysis;
  diff: LineDiff;
  hasOutline: boolean;
}

export interface ContextLocation {
  uri: vscode.Uri;
  line: number;
}

export interface BuiltModel {
  model: UmlModel;
  deltas: Map<string, DeltaFile>;
  contextLocations: Map<string, ContextLocation>;
}

export function fileKeyOf(repoRoot: string, relPath: string): string {
  return `${repoRoot}:${relPath}`;
}

async function readSide(
  uri: vscode.Uri,
): Promise<{ lines: string[]; languageId: string } | undefined> {
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();
    if (text.includes("\u0000")) {
      return undefined;
    }
    return { lines: splitLines(text), languageId: doc.languageId };
  } catch (err) {
    log.debug(
      `[uml] could not read ${uri.toString()}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

async function outlineOf(
  uri: vscode.Uri,
  lines: string[],
  languageId: string,
): Promise<OutlineType[] | undefined> {
  const symbols = await documentSymbols(uri, languageId);
  return symbols ? extractOutline(symbols, lines) : undefined;
}

async function outlineFromCopy(
  relPath: string,
  lines: string[],
  languageId: string,
): Promise<OutlineType[] | undefined> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paireto-uml-"));
  const copy = path.join(dir, path.basename(relPath));
  try {
    await fs.writeFile(copy, lines.join("\n"), "utf8");
    return await outlineOf(vscode.Uri.file(copy), lines, languageId);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function hasCode(lines: readonly string[]): boolean {
  return lines.some((line) => line.trim() !== "");
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

function typeKindOf(kind: vscode.SymbolKind): TypeKind {
  switch (kind) {
    case vscode.SymbolKind.Interface:
      return "interface";
    case vscode.SymbolKind.Enum:
      return "enum";
    case vscode.SymbolKind.Struct:
      return "struct";
    default:
      return "class";
  }
}

function fileChange(status: string): TypeChange {
  return status === "A" ? "added" : status === "D" ? "removed" : "modified";
}

export class UmlModelBuilder {
  private readonly analyses = new Map<string, FileAnalysis>();
  private readonly definitions = new Map<string, vscode.SymbolInformation | null>();

  constructor(
    private readonly review: Pick<ReviewController, "getState" | "getComments">,
    private readonly seen: Pick<SeenFiles, "isSeen">,
  ) {}

  clearCaches(): void {
    this.analyses.clear();
    this.definitions.clear();
  }

  private async analyse(delta: DeltaFile, compareRef: string | null): Promise<FileAnalysis> {
    const key = fileKeyOf(delta.repoRoot, delta.path);
    const modifiedUri = vscode.Uri.file(path.join(delta.repoRoot, delta.path));
    const openDoc = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === modifiedUri.toString(),
    );
    const contentKey = `${delta.contentId}:${delta.status}:${openDoc?.isDirty ? openDoc.version : "disk"}`;
    const cached = this.analyses.get(key);
    if (cached && cached.contentKey === contentKey) {
      return cached;
    }
    const baseUri =
      delta.status === "A"
        ? undefined
        : ReviewPath.create({
            reviewId: "uml",
            side: "base",
            relPath: delta.oldPath ?? delta.path,
            ref: compareRef ?? "HEAD",
            repoRoot: delta.repoRoot,
          }).toUri();
    const [base, modified] = await Promise.all([
      baseUri ? readSide(baseUri) : Promise.resolve(undefined),
      delta.status === "D" ? Promise.resolve(undefined) : readSide(modifiedUri),
    ]);
    const languageId = modified?.languageId ?? base?.languageId ?? "plaintext";
    const diff = diffLines(base?.lines ?? [], modified?.lines ?? []);
    const tooLong = Math.max(base?.lines.length ?? 0, modified?.lines.length ?? 0) > MAX_LINES;
    let analysis: FileAnalysis = { contentKey, diff, hasOutline: false };
    if (!NON_CODE_LANGUAGES.has(languageId) && !tooLong && (base || modified)) {
      const [directBase, modifiedTypes] = await Promise.all([
        base && baseUri ? outlineOf(baseUri, base.lines, languageId) : Promise.resolve(undefined),
        modified ? outlineOf(modifiedUri, modified.lines, languageId) : Promise.resolve(undefined),
      ]);
      const baseNeedsCopy =
        !!base &&
        hasCode(base.lines) &&
        (directBase === undefined || (directBase.length === 0 && (modifiedTypes?.length ?? 0) > 0));
      const baseTypes =
        baseNeedsCopy && base
          ? ((await outlineFromCopy(delta.oldPath ?? delta.path, base.lines, languageId)) ??
            directBase)
          : directBase;
      const baseMissing = !!base && baseTypes === undefined;
      const modifiedMissing = !!modified && modifiedTypes === undefined;
      const hasOutline =
        !baseMissing &&
        !modifiedMissing &&
        ((baseTypes?.length ?? 0) > 0 || (modifiedTypes?.length ?? 0) > 0);
      analysis = {
        contentKey,
        diff,
        hasOutline,
        base: base && baseTypes ? { lineCount: base.lines.length, types: baseTypes } : undefined,
        modified:
          modified && modifiedTypes
            ? { lineCount: modified.lines.length, types: modifiedTypes }
            : undefined,
      };
    }
    this.analyses.set(key, analysis);
    return analysis;
  }

  async build(progress: (message: string) => void): Promise<BuiltModel> {
    const state = this.review.getState();
    const threads = this.review
      .getComments()
      .filter((thread) => !thread.resolvedAt && !thread.changeset);
    const threadsByFile = new Map<string, ThreadPosition[]>();
    for (const thread of threads) {
      const key = fileKeyOf(thread.repoRoot, thread.filePath);
      threadsByFile.set(key, [
        ...(threadsByFile.get(key) ?? []),
        { side: thread.side, line: thread.line },
      ]);
    }

    const deltas = new Map<string, DeltaFile>();
    const files: UmlFile[] = [];
    const work: { delta: DeltaFile; compareRef: string | null; file: UmlFile }[] = [];
    const notes: string[] = [];
    const labels = new Set<string>();
    for (const repository of state.repositories) {
      labels.add(repository.changes.compareLabel);
      for (const delta of buildDelta(repository.repoRoot, repository.changes)) {
        const key = fileKeyOf(delta.repoRoot, delta.path);
        const file: UmlFile = {
          key,
          repoRoot: delta.repoRoot,
          repoName: repository.displayName,
          path: delta.path,
          status: delta.status,
          counts: { added: delta.additions, removed: delta.deletions },
          read: this.seen.isSeen(delta),
          openThreads: threadsByFile.get(key)?.length ?? 0,
          hasOutline: false,
          changes: [],
        };
        deltas.set(key, delta);
        files.push(file);
        if (work.length < MAX_FILES) {
          work.push({ delta, compareRef: repository.changes.compareRef, file });
        }
      }
    }
    if (files.length > MAX_FILES) {
      notes.push(`Only the first ${MAX_FILES} of ${files.length} changed files are shown.`);
    }

    let done = 0;
    const perFile = await mapLimited(work, CONCURRENCY, async ({ delta, compareRef, file }) => {
      const analysis = await this.analyse(delta, compareRef);
      done++;
      progress(`Reading symbols… ${done}/${work.length} files`);
      const fileName = path.basename(delta.path);
      const fileThreads = threadsByFile.get(file.key) ?? [];
      if (
        analysis.diff.added.size + analysis.diff.removed.size > 0 &&
        file.counts.added + file.counts.removed === 0
      ) {
        file.counts = { added: analysis.diff.added.size, removed: analysis.diff.removed.size };
      }
      file.hasOutline = analysis.hasOutline;
      file.changes = diffHunks(analysis.diff);
      if (!analysis.hasOutline) {
        return [
          fileType(file.key, fileName, fileChange(delta.status), file.counts, fileThreads.length),
        ];
      }
      return diffFile({
        fileKey: file.key,
        fileName,
        base: analysis.base,
        modified: analysis.modified,
        diff: analysis.diff,
        threads: fileThreads,
      });
    });
    const entries: DiffedType[] = perFile.flat();

    progress("Finding related types…");
    const contextLocations = new Map<string, ContextLocation>();
    const contextTypes: UmlType[] = [];
    const names = unresolvedNames(entries, MAX_CONTEXT_LOOKUPS);
    const found = await mapLimited(names, CONCURRENCY, async (name) => {
      if (!this.definitions.has(name)) {
        this.definitions.set(name, (await findTypeDefinition(name)) ?? null);
      }
      return { name, symbol: this.definitions.get(name) ?? undefined };
    });
    for (const { name, symbol } of found) {
      if (!symbol) {
        continue;
      }
      const uri = symbol.location.uri;
      const repository = state.repositories.find((r) =>
        uri.fsPath.startsWith(r.repoRoot + path.sep),
      );
      const relPath = repository
        ? path.relative(repository.repoRoot, uri.fsPath).split(path.sep).join("/")
        : vscode.workspace.asRelativePath(uri);
      const key = `context:${uri.toString()}`;
      if (!files.some((f) => f.key === key)) {
        files.push({
          key,
          repoRoot: repository?.repoRoot ?? "",
          repoName: repository?.displayName ?? "",
          path: relPath,
          status: "context",
          counts: { added: 0, removed: 0 },
          read: true,
          openThreads: 0,
          hasOutline: true,
          changes: [],
        });
      }
      const id = `${key}::${name}`;
      contextLocations.set(id, { uri, line: symbol.location.range.start.line });
      contextTypes.push({
        id,
        name,
        kind: typeKindOf(symbol.kind),
        isAbstract: false,
        fileKey: key,
        change: "unchanged",
        headerChanged: false,
        counts: { added: 0, removed: 0 },
        members: [],
        context: true,
        openThreads: 0,
      });
    }

    const withoutOutline = files.filter((f) => f.status !== "context" && !f.hasOutline).length;
    if (withoutOutline > 0) {
      notes.push(
        `${withoutOutline} ${withoutOutline === 1 ? "file has" : "files have"} no class or function symbols and ${withoutOutline === 1 ? "shows" : "show"} as a file box.`,
      );
    }
    return {
      model: {
        comparison: [...labels].join(", "),
        repoCount: state.repositories.length,
        files,
        types: [...entries.map((e) => e.type), ...contextTypes],
        relations: buildRelations(entries, contextTypes),
        notes,
      },
      deltas,
      contextLocations,
    };
  }
}
