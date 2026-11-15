import * as path from "node:path";

import type { CompareTo } from "../protocol/guidedReview.js";
import type { VizFile } from "../protocol/viz.js";
import type {
  ChangedSource,
  GenerateDeps,
  SourceLocation,
  SourceText,
  TypeSymbol,
} from "../viz/generate/generate.js";
import { diffFile } from "../viz/generate/fileDiff.js";
import { diffLines } from "../viz/generate/lineDiff.js";
import type { DiffSide, DiffedType } from "../viz/generate/model.js";
import { extractOutline, SymbolKinds, type OutlineSymbol } from "../viz/generate/outline.js";
import type { VizEnv } from "../viz/model/compile.js";
import type { VizRepo } from "../viz/model/types.js";

export function symbol(
  name: string,
  kind: number,
  lines: string[],
  start: number,
  end: number,
  children: OutlineSymbol[] = [],
  detail = "",
): OutlineSymbol {
  const plain = name.replace(/^\(\*?\w+\)\./, "").split("(")[0];
  const startChar = Math.max(0, lines[start].indexOf(plain));
  return {
    name,
    detail,
    kind,
    range: { startLine: start, startChar: 0, endLine: end, endChar: lines[end].length },
    selection: { startLine: start, startChar, endLine: start, endChar: startChar + plain.length },
    children,
  };
}

export interface FixtureSide {
  text: string;
  languageId: string;
  symbols?: (lines: string[]) => OutlineSymbol[];
}

export interface FixtureFile extends ChangedSource {
  base?: FixtureSide;
  modified?: FixtureSide;
}

export interface FixtureWorld {
  repos: VizRepo[];
  files: FixtureFile[];
  types?: Record<string, TypeSymbol>;
  definitions?: (file: FixtureFile, line: number, character: number) => SourceLocation | undefined;
  onDisk?: string[];
}

export const COMPARE_TO: CompareTo = { kind: "mergeBase" };

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  return lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
}

export function fixtureDeps(world: FixtureWorld): GenerateDeps<FixtureFile> & {
  calls: string[];
} {
  const calls: string[] = [];
  const side = (file: FixtureFile, which: DiffSide) =>
    which === "base" ? file.base : file.modified;
  return {
    calls,
    scope: () => ({
      repoName: world.repos[0].name,
      compareTo: COMPARE_TO,
      compareLabel: "main",
      repos: world.repos,
      files: world.files,
    }),
    read: async (file, which) => {
      const found = side(file, which);
      return found && { lines: linesOf(found.text), languageId: found.languageId };
    },
    symbols: async (file, which, text: SourceText) => {
      calls.push(`symbols ${which} ${file.path}`);
      return side(file, which)?.symbols?.(text.lines);
    },
    symbolsFromCopy: async (file) => {
      calls.push(`copy ${file.path}`);
      return undefined;
    },
    findType: async (name) => {
      calls.push(`type ${name}`);
      return world.types?.[name];
    },
    definition: async (file, line, character) => {
      calls.push(`definition ${file.path}:${line}:${character}`);
      return world.definitions?.(file, line, character);
    },
  };
}

export function fixtureEnv(world: FixtureWorld): VizEnv {
  const onDisk = new Set(world.onDisk ?? []);
  return {
    repoName: world.repos[0].name,
    repos: world.repos,
    changed: world.files.map((file) => ({
      repo: file.repo,
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    fileExists: (repo, file) => onDisk.has(`${repo}/${file}`),
  };
}

export function rootOf(world: FixtureWorld, repo: string, file: string): string {
  const root = world.repos.find((candidate) => candidate.name === repo)?.root ?? "/";
  return path.join(root, file);
}

export function nodeById(viz: VizFile, id: string) {
  const node = viz.nodes.find((candidate) => candidate.id === id);
  if (!node) {
    throw new Error(`no node ${id} in ${viz.nodes.map((n) => n.id).join(", ")}`);
  }
  return node;
}

export const USERS_BASE = [
  "export interface Store {",
  "  get(id: string): User;",
  "}",
  "export class UserService implements Store {",
  "  private cache: User[] = [];",
  "  get(id: string): User {",
  "    return this.cache[0];",
  "  }",
  "  remove(id: string): void {",
  "    this.cache = [];",
  "  }",
  "  count(): number {",
  "    return 1;",
  "  }",
  "}",
  "export class User {",
  "  name: string;",
  "}",
  "export function helper(): void {}",
];

export const USERS_MODIFIED = [
  "export interface Store {",
  "  get(id: string, fresh: boolean): User;",
  "}",
  "export class UserService implements Store {",
  "  private cache: User[] = [];",
  "  get(id: string, fresh: boolean): User {",
  "    return this.cache[0];",
  "  }",
  "  count(): number {",
  "    return this.cache.length;",
  "  }",
  "  clear(): void {",
  "    this.cache = [];",
  "  }",
  "}",
  "export class User {",
  "  name: string;",
  "}",
  "export function helper(): void {}",
];

export function usersBaseSymbols(lines: string[]): OutlineSymbol[] {
  return [
    symbol("Store", SymbolKinds.Interface, lines, 0, 2, [
      symbol("get", SymbolKinds.Method, lines, 1, 1),
    ]),
    symbol("UserService", SymbolKinds.Class, lines, 3, 14, [
      symbol("cache", SymbolKinds.Property, lines, 4, 4),
      symbol("get", SymbolKinds.Method, lines, 5, 7),
      symbol("remove", SymbolKinds.Method, lines, 8, 10),
      symbol("count", SymbolKinds.Method, lines, 11, 13),
    ]),
    symbol("User", SymbolKinds.Class, lines, 15, 17, [
      symbol("name", SymbolKinds.Property, lines, 16, 16),
    ]),
    symbol("helper", SymbolKinds.Function, lines, 18, 18),
  ];
}

export function usersModifiedSymbols(lines: string[]): OutlineSymbol[] {
  return [
    symbol("Store", SymbolKinds.Interface, lines, 0, 2, [
      symbol("get", SymbolKinds.Method, lines, 1, 1),
    ]),
    symbol("UserService", SymbolKinds.Class, lines, 3, 14, [
      symbol("cache", SymbolKinds.Property, lines, 4, 4),
      symbol("get", SymbolKinds.Method, lines, 5, 7),
      symbol("count", SymbolKinds.Method, lines, 8, 10),
      symbol("clear", SymbolKinds.Method, lines, 11, 13),
    ]),
    symbol("User", SymbolKinds.Class, lines, 15, 17, [
      symbol("name", SymbolKinds.Property, lines, 16, 16),
    ]),
    symbol("helper", SymbolKinds.Function, lines, 18, 18),
  ];
}

export function usersFile(): DiffedType[] {
  return diffFile(
    extractOutline(usersBaseSymbols(USERS_BASE), USERS_BASE),
    extractOutline(usersModifiedSymbols(USERS_MODIFIED), USERS_MODIFIED),
    diffLines(USERS_BASE, USERS_MODIFIED),
  );
}
