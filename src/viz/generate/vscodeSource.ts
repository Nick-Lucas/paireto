import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import * as vscode from "vscode";

import { log } from "../../log.js";
import type { CompareTo } from "../../protocol/guidedReview.js";
import { canonicalize } from "../../protocol/paths.js";
import { buildDelta } from "../../review/delta.js";
import type { ReviewState } from "../../review/ReviewController.js";
import { ReviewPath } from "../../review/ReviewPath.js";
import { uniqueRepoNames, vizStatus } from "../host/changes.js";
import type {
  ChangedSource,
  GenerateDeps,
  GenerateScope,
  SourceLocation,
  SourceText,
  TypeSymbol,
} from "./generate.js";
import { splitLines } from "./lineDiff.js";
import type { ContextKind, DiffSide } from "./model.js";
import type { OutlineSymbol } from "./outline.js";
import { definitionAt, documentSymbols, findTypeDefinition } from "./symbols.js";

const MAX_CACHED_FILES = 2000;

export interface GenerateReview {
  getState(): ReviewState;
  compareToFor(repoRoot: string): CompareTo;
}

export interface VscodeChangedFile extends ChangedSource {
  repoRoot: string;
  baseRef: string;
}

const CONTEXT_KINDS = new Map<vscode.SymbolKind, ContextKind>([
  [vscode.SymbolKind.Interface, "interface"],
  [vscode.SymbolKind.Enum, "enum"],
  [vscode.SymbolKind.Struct, "struct"],
]);

function uriOf(file: VscodeChangedFile, side: DiffSide): vscode.Uri {
  return side === "base"
    ? ReviewPath.create({
        reviewId: "viz",
        side: "base",
        relPath: file.oldPath ?? file.path,
        ref: file.baseRef,
        repoRoot: file.repoRoot,
      }).toUri()
    : vscode.Uri.file(path.join(file.repoRoot, file.path));
}

function contentKey(via: "direct" | "copy", text: SourceText): string {
  return crypto
    .createHash("sha256")
    .update(`${via}\n${text.languageId}\n${text.lines.join("\n")}`)
    .digest("hex");
}

export class VscodeGenerateSource implements GenerateDeps<VscodeChangedFile> {
  private readonly symbolCache = new Map<string, OutlineSymbol[]>();
  private readonly typeCache = new Map<string, TypeSymbol | null>();

  constructor(
    private readonly review: GenerateReview,
    readonly progress?: (message: string) => void,
  ) {}

  clearCaches(): void {
    this.symbolCache.clear();
    this.typeCache.clear();
  }

  scope(repoRoot: string): GenerateScope<VscodeChangedFile> {
    const repositories = this.review.getState().repositories;
    const names = uniqueRepoNames(repositories.map((repository) => repository.displayName));
    const repos = repositories.map((repository, at) => ({
      name: names[at],
      root: repository.repoRoot,
      repository,
    }));
    const callerRoot = canonicalize(repoRoot);
    const caller = repos.find((repo) => canonicalize(repo.root) === callerRoot);
    if (!caller) {
      throw new Error(`${repoRoot} is not a repository open in this window.`);
    }
    const ordered = [caller, ...repos.filter((repo) => repo !== caller)];
    return {
      repoName: caller.name,
      compareTo: this.review.compareToFor(caller.root),
      compareLabel: caller.repository.changes.compareLabel,
      repos: ordered.map(({ name, root }) => ({ name, root })),
      files: ordered.flatMap(({ name, repository }) =>
        buildDelta(repository.repoRoot, repository.changes).map((delta): VscodeChangedFile => ({
          repo: name,
          path: delta.path,
          ...(delta.oldPath !== undefined && { oldPath: delta.oldPath }),
          status: vizStatus(delta.status),
          additions: delta.additions,
          deletions: delta.deletions,
          repoRoot: repository.repoRoot,
          baseRef: repository.changes.compareRef ?? "HEAD",
        })),
      ),
    };
  }

  async read(file: VscodeChangedFile, side: DiffSide): Promise<SourceText | undefined> {
    const uri = uriOf(file, side);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      return text.includes("\u0000")
        ? undefined
        : { lines: splitLines(text), languageId: doc.languageId };
    } catch (err) {
      log.debug(
        `[viz] could not read ${uri.toString()}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  symbols(
    file: VscodeChangedFile,
    side: DiffSide,
    text: SourceText,
  ): Promise<OutlineSymbol[] | undefined> {
    return this.cached(contentKey("direct", text), () =>
      documentSymbols(uriOf(file, side), text.languageId),
    );
  }

  symbolsFromCopy(file: VscodeChangedFile, text: SourceText): Promise<OutlineSymbol[] | undefined> {
    return this.cached(contentKey("copy", text), async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paireto-viz-"));
      const copy = path.join(dir, path.basename(file.oldPath ?? file.path));
      try {
        await fs.writeFile(copy, text.lines.join("\n"), "utf8");
        return await documentSymbols(vscode.Uri.file(copy), text.languageId);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }

  async findType(name: string): Promise<TypeSymbol | undefined> {
    if (!this.typeCache.has(name)) {
      const symbol = await findTypeDefinition(name);
      this.typeCache.set(
        name,
        symbol
          ? {
              fsPath: symbol.location.uri.fsPath,
              line: symbol.location.range.start.line,
              kind: CONTEXT_KINDS.get(symbol.kind) ?? "class",
            }
          : null,
      );
    }
    return this.typeCache.get(name) ?? undefined;
  }

  async definition(
    file: VscodeChangedFile,
    line: number,
    character: number,
  ): Promise<SourceLocation | undefined> {
    const found = await definitionAt(uriOf(file, "modified"), new vscode.Position(line, character));
    return found && found.uri.scheme === "file"
      ? { fsPath: found.uri.fsPath, line: found.line }
      : undefined;
  }

  private async cached(
    key: string,
    load: () => Promise<OutlineSymbol[] | undefined>,
  ): Promise<OutlineSymbol[] | undefined> {
    const known = this.symbolCache.get(key);
    if (known) {
      return known;
    }
    const symbols = await load();
    if (symbols) {
      if (this.symbolCache.size >= MAX_CACHED_FILES) {
        this.symbolCache.delete(this.symbolCache.keys().next().value as string);
      }
      this.symbolCache.set(key, symbols);
    }
    return symbols;
  }
}
