import type { Compartment, TypeKind } from "./model.js";
import { baseName, collapse, parseSignature, type ParsedSignature } from "./signature.js";

export interface TextRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

export interface OutlineSymbol {
  name: string;
  detail: string;
  kind: number;
  range: TextRange;
  selection: TextRange;
  children: OutlineSymbol[];
}

export const SymbolKinds = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  Object: 18,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const;

export interface OutlineMember {
  key: string;
  name: string;
  compartment: Compartment;
  signature: string;
  body: string;
  start: number;
  end: number;
  parsed: ParsedSignature;
}

export interface OutlineType {
  key: string;
  name: string;
  kind: TypeKind;
  header: string;
  supertypes: string[];
  realizes: string[];
  isAbstract: boolean;
  start: number;
  end: number;
  members: OutlineMember[];
}

export const MODULE_KEY = "<module>";

const TYPE_KINDS: Record<number, TypeKind> = {
  [SymbolKinds.Class]: "class",
  [SymbolKinds.Interface]: "interface",
  [SymbolKinds.Enum]: "enum",
  [SymbolKinds.Struct]: "struct",
};

const CONTAINER_KINDS = new Set<number>([
  SymbolKinds.Module,
  SymbolKinds.Namespace,
  SymbolKinds.Package,
]);

const FIELD_KINDS = new Set<number>([
  SymbolKinds.Property,
  SymbolKinds.Field,
  SymbolKinds.Variable,
  SymbolKinds.Constant,
  SymbolKinds.EnumMember,
  SymbolKinds.Event,
]);

const METHOD_KINDS = new Set<number>([
  SymbolKinds.Method,
  SymbolKinds.Constructor,
  SymbolKinds.Function,
  SymbolKinds.Operator,
]);

const MAX_SIGNATURE_LINES = 12;

export function compartmentOf(kind: number): Compartment | undefined {
  if (METHOD_KINDS.has(kind)) {
    return "method";
  }
  if (FIELD_KINDS.has(kind)) {
    return "field";
  }
  return undefined;
}

function stripComments(line: string): string {
  return line.replace(/\/\*.*?\*\//g, " ").replace(/\/\/.*$/, "");
}

export function signatureEnd(
  lines: readonly string[],
  selection: TextRange,
  limit: TextRange,
): {
  line: number;
  char: number;
} {
  let depth = 0;
  const lastLine = Math.min(
    limit.endLine,
    selection.startLine + MAX_SIGNATURE_LINES,
    lines.length - 1,
  );
  for (let lineNo = selection.startLine; lineNo <= lastLine; lineNo++) {
    const raw = lines[lineNo] ?? "";
    const text = stripComments(raw);
    const from = lineNo === selection.startLine ? selection.startChar : 0;
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      const next = text[i + 1] ?? "";
      const prev = text[i - 1] ?? "";
      if (ch === "(" || ch === "[" || (ch === "<" && /[\w$\s]/.test(prev) && next !== "=")) {
        depth++;
        continue;
      }
      if (ch === ")" || ch === "]" || (ch === ">" && prev !== "-" && prev !== "=" && depth > 0)) {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth > 0) {
        continue;
      }
      if (ch === "{" || ch === ";") {
        return { line: lineNo, char: i };
      }
      if (ch === "=" && next === ">") {
        return { line: lineNo, char: i };
      }
      if (ch === "=" && next !== "=" && !/[!<>=]/.test(prev)) {
        return { line: lineNo, char: i };
      }
      if (
        ch === ":" &&
        text.slice(i + 1).trim() === "" &&
        !(lineNo === limit.endLine && i >= limit.endChar)
      ) {
        return { line: lineNo, char: i };
      }
    }
  }
  const endLine = Math.min(selection.startLine, lastLine);
  return { line: endLine, char: (lines[endLine] ?? "").length };
}

function sliceText(
  lines: readonly string[],
  from: { line: number; char: number },
  to: { line: number; char: number },
): string {
  if (from.line > to.line) {
    return "";
  }
  if (from.line === to.line) {
    return (lines[from.line] ?? "").slice(from.char, to.char);
  }
  const parts = [(lines[from.line] ?? "").slice(from.char)];
  for (let line = from.line + 1; line < to.line; line++) {
    parts.push(lines[line] ?? "");
  }
  parts.push((lines[to.line] ?? "").slice(0, to.char));
  return parts.join("\n");
}

function signatureOf(
  lines: readonly string[],
  symbol: OutlineSymbol,
): { signature: string; body: string } {
  const end = signatureEnd(lines, symbol.selection, symbol.range);
  const startLine = symbol.selection.startLine;
  const signature = collapse(
    stripComments(sliceText(lines, { line: startLine, char: 0 }, end)).replace(
      /^\s*@[\w.]+(\([^)]*\))?\s*/g,
      "",
    ),
  );
  const body = collapse(
    sliceText(lines, end, { line: symbol.range.endLine, char: symbol.range.endChar }),
  );
  return { signature, body };
}

function memberOf(
  lines: readonly string[],
  symbol: OutlineSymbol,
  compartment: Compartment,
): Omit<OutlineMember, "key"> {
  const { signature, body } = signatureOf(lines, symbol);
  const name = baseName(symbol.name);
  return {
    name,
    compartment,
    signature,
    body,
    start: symbol.range.startLine,
    end: symbol.range.endLine,
    parsed: parseSignature(signature, name, compartment, symbol.detail),
  };
}

function withKeys(members: Omit<OutlineMember, "key">[]): OutlineMember[] {
  const seen = new Map<string, number>();
  return members.map((member) => {
    const base = `${member.compartment}:${member.name}`;
    const index = seen.get(base) ?? 0;
    seen.set(base, index + 1);
    return { ...member, key: index === 0 ? base : `${base}#${index}` };
  });
}

const IMPL_BLOCK = /^impl(?:\s*<.*>)?\s+(?:([\w:]+)(?:<.*>)?\s+for\s+)?([\w:]+)/;

function headerTypes(header: string, name: string): { supertypes: string[]; realizes: string[] } {
  const at = header.indexOf(name);
  let rest = at < 0 ? header : header.slice(at + name.length);
  rest = rest.trimStart();
  if (rest.startsWith("<")) {
    let depth = 0;
    let i = 0;
    for (; i < rest.length; i++) {
      if (rest[i] === "<") {
        depth++;
      } else if (rest[i] === ">") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
    }
    rest = rest.slice(i + 1);
  }
  let previous = "";
  while (previous !== rest) {
    previous = rest;
    rest = rest.replace(/<[^<>]*>/g, " ");
  }
  const supertypes: string[] = [];
  const realizes: string[] = [];
  let bucket = supertypes;
  for (const token of rest.split(/[^\w$.]+/)) {
    if (token === "") {
      continue;
    }
    if (token === "implements" || token === "conforms") {
      bucket = realizes;
      continue;
    }
    if (token === "extends" || token === "inherits") {
      bucket = supertypes;
      continue;
    }
    bucket.push(token.split(".").pop() ?? token);
  }
  return { supertypes, realizes };
}

function byPosition(list: readonly OutlineSymbol[]): OutlineSymbol[] {
  return [...list].sort(
    (a, b) => a.range.startLine - b.range.startLine || a.range.startChar - b.range.startChar,
  );
}

export function extractOutline(
  symbols: readonly OutlineSymbol[],
  lines: readonly string[],
): OutlineType[] {
  const types: OutlineType[] = [];
  const moduleMembers: Omit<OutlineMember, "key">[] = [];
  const pendingMethods: { owner: string; symbol: OutlineSymbol }[] = [];
  const implBlocks: { owner: string; trait?: string; symbol: OutlineSymbol }[] = [];

  const addType = (symbol: OutlineSymbol, kind: TypeKind, prefix: string): void => {
    const name = `${prefix}${baseName(symbol.name)}`;
    const { signature } = signatureOf(lines, symbol);
    const members: Omit<OutlineMember, "key">[] = [];
    const nested: OutlineSymbol[] = [];
    for (const child of byPosition(symbol.children)) {
      const compartment = compartmentOf(child.kind);
      if (TYPE_KINDS[child.kind] !== undefined || CONTAINER_KINDS.has(child.kind)) {
        nested.push(child);
      } else if (compartment) {
        members.push(memberOf(lines, child, compartment));
      }
    }
    const { supertypes, realizes } = headerTypes(signature, baseName(symbol.name));
    types.push({
      key: name,
      name,
      kind,
      header: signature,
      supertypes,
      realizes,
      isAbstract: /\babstract\b/.test(signature),
      start: symbol.range.startLine,
      end: symbol.range.endLine,
      members: withKeys(members),
    });
    walk(nested, `${name}.`);
  };

  const walk = (list: readonly OutlineSymbol[], prefix: string): void => {
    for (const symbol of byPosition(list)) {
      const typeKind = TYPE_KINDS[symbol.kind];
      if (typeKind !== undefined) {
        addType(symbol, typeKind, prefix);
        continue;
      }
      const impl = IMPL_BLOCK.exec(symbol.name);
      if (
        impl &&
        (symbol.kind === SymbolKinds.Object ||
          symbol.kind === SymbolKinds.Namespace ||
          symbol.kind === SymbolKinds.Module ||
          symbol.kind === SymbolKinds.Class)
      ) {
        implBlocks.push({
          owner: impl[2].split("::").pop() ?? impl[2],
          trait: impl[1]?.split("::").pop(),
          symbol,
        });
        continue;
      }
      if (CONTAINER_KINDS.has(symbol.kind)) {
        walk(symbol.children, `${prefix}${baseName(symbol.name)}.`);
        continue;
      }
      const compartment = compartmentOf(symbol.kind);
      if (!compartment) {
        continue;
      }
      const goOwner = /^\(?\*?([\w]+)\)?\.\w+$/.exec(symbol.name);
      if (goOwner && symbol.kind === SymbolKinds.Method) {
        pendingMethods.push({ owner: goOwner[1], symbol });
        continue;
      }
      if (prefix === "") {
        moduleMembers.push(memberOf(lines, symbol, compartment));
      }
    }
  };

  walk(symbols, "");

  const byName = new Map(types.map((type) => [type.name, type]));
  const attach = (owner: string, symbol: OutlineSymbol): boolean => {
    const type = byName.get(owner);
    const compartment = compartmentOf(symbol.kind);
    if (!type || !compartment) {
      return false;
    }
    const existing = type.members.map(({ key: _key, ...rest }) => rest);
    type.members = withKeys([...existing, memberOf(lines, symbol, compartment)]);
    type.start = Math.min(type.start, symbol.range.startLine);
    return true;
  };
  for (const { owner, symbol } of pendingMethods) {
    if (!attach(owner, symbol)) {
      moduleMembers.push(memberOf(lines, symbol, "method"));
    }
  }
  for (const block of implBlocks) {
    const type = byName.get(block.owner);
    if (block.trait && type && !type.realizes.includes(block.trait)) {
      type.realizes.push(block.trait);
    }
    for (const child of block.symbol.children) {
      if (!attach(block.owner, child)) {
        const compartment = compartmentOf(child.kind);
        if (compartment) {
          moduleMembers.push(memberOf(lines, child, compartment));
        }
      }
    }
  }

  if (moduleMembers.length > 0) {
    types.push({
      key: MODULE_KEY,
      name: MODULE_KEY,
      kind: "module",
      header: "",
      supertypes: [],
      realizes: [],
      isAbstract: false,
      start: Math.min(...moduleMembers.map((member) => member.start)),
      end: Math.max(...moduleMembers.map((member) => member.end)),
      members: withKeys(moduleMembers),
    });
  }
  return types;
}

export function nestSymbols(flat: readonly OutlineSymbol[]): OutlineSymbol[] {
  const sorted = [...flat].sort(
    (a, b) =>
      a.range.startLine - b.range.startLine ||
      b.range.endLine - a.range.endLine ||
      a.range.startChar - b.range.startChar,
  );
  const roots: OutlineSymbol[] = [];
  const stack: OutlineSymbol[] = [];
  const contains = (outer: TextRange, inner: TextRange): boolean =>
    (outer.startLine < inner.startLine ||
      (outer.startLine === inner.startLine && outer.startChar <= inner.startChar)) &&
    (outer.endLine > inner.endLine ||
      (outer.endLine === inner.endLine && outer.endChar >= inner.endChar));
  for (const symbol of sorted) {
    const node = { ...symbol, children: [] as OutlineSymbol[] };
    while (stack.length > 0 && !contains(stack[stack.length - 1].range, node.range)) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }
  return roots;
}
