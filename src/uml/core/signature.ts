import type { Compartment, Visibility } from "./model.js";

export interface ParsedSignature {
  visibility?: Visibility;
  isStatic: boolean;
  isAbstract: boolean;
  params?: string;
  type?: string;
  label: string;
  short: string;
}

const VISIBILITY: Record<string, Visibility> = {
  public: "+",
  pub: "+",
  export: "+",
  private: "-",
  fileprivate: "-",
  protected: "#",
  internal: "~",
};

const KEYWORDS = new Set([
  "abstract",
  "async",
  "class",
  "const",
  "constexpr",
  "convenience",
  "declare",
  "def",
  "default",
  "dynamic",
  "enum",
  "explicit",
  "extern",
  "final",
  "fn",
  "friend",
  "fun",
  "func",
  "function",
  "get",
  "impl",
  "inline",
  "interface",
  "lateinit",
  "lazy",
  "let",
  "mut",
  "mutating",
  "native",
  "new",
  "open",
  "operator",
  "optional",
  "override",
  "partial",
  "readonly",
  "record",
  "required",
  "sealed",
  "set",
  "static",
  "struct",
  "sub",
  "suspend",
  "synchronized",
  "trait",
  "transient",
  "type",
  "unsafe",
  "val",
  "var",
  "virtual",
  "volatile",
  "weak",
  ...Object.keys(VISIBILITY),
]);

const TRAILING_CLAUSE = /\s+(throws|where|noexcept|const|override|final|async)\b.*$/;

export function baseName(name: string): string {
  const goMethod = /^\(?\*?[\w.]+\)?\.(\w+)$/.exec(name);
  if (goMethod) {
    return goMethod[1];
  }
  return name.split("(")[0].trim();
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function findWord(text: string, word: string, from = 0): number {
  if (word === "") {
    return -1;
  }
  let index = text.indexOf(word, from);
  while (index >= 0) {
    const before = index === 0 ? "" : text[index - 1];
    const after = text[index + word.length] ?? "";
    if (!/[\w$]/.test(before) && !/[\w$]/.test(after)) {
      return index;
    }
    index = text.indexOf(word, index + 1);
  }
  return -1;
}

export function balancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "(" ? ")" : open === "<" ? ">" : "]";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === open) {
      depth++;
    } else if (ch === close && !(close === ">" && (text[i - 1] === "-" || text[i - 1] === "="))) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return text.length - 1;
}

function stripDecorations(prefix: string): string {
  return prefix
    .replace(/@[\w.]+(\([^)]*\))?/g, " ")
    .replace(/\bfunc\s*\([^)]*\)/g, "func ")
    .replace(/\bpub\s*\([^)]*\)/g, "pub ")
    .replace(/\[[^\]]*\]/g, (match) => (/^\[\s*\]$/.test(match) ? match : " "));
}

function compactParams(params: string): string {
  const parts = splitTopLevel(params)
    .map(collapse)
    .filter((part) => part !== "" && !/^(&\s*)?(mut\s+)?(self|cls|this)\b(\s*:.*)?$/.test(part));
  return parts.join(", ");
}

export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
      depth++;
    } else if (
      ch === ")" ||
      ch === "]" ||
      ch === "}" ||
      (ch === ">" && text[i - 1] !== "=" && text[i - 1] !== "-")
    ) {
      depth--;
    }
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

export function parseSignature(
  signature: string,
  name: string,
  compartment: Compartment,
  detail = "",
): ParsedSignature {
  const plain = baseName(name);
  const nameAt = findWord(signature, plain);
  const at = nameAt < 0 ? signature.indexOf(plain) : nameAt;
  const prefix = at < 0 ? "" : signature.slice(0, at);
  let rest = at < 0 ? "" : signature.slice(at + plain.length);

  let visibility: Visibility | undefined;
  let isStatic = false;
  let isAbstract = false;
  const prefixType: string[] = [];
  for (const token of collapse(stripDecorations(prefix)).split(" ")) {
    if (token === "") {
      continue;
    }
    if (VISIBILITY[token] && visibility === undefined) {
      visibility = VISIBILITY[token];
    }
    if (token === "static") {
      isStatic = true;
    }
    if (token === "abstract") {
      isAbstract = true;
    }
    if (!KEYWORDS.has(token)) {
      prefixType.push(token);
    }
  }
  if (plain.startsWith("#")) {
    visibility = "-";
  } else if (/^_[^_]|^__\w*[^_]$/.test(plain) && visibility === undefined) {
    visibility = "-";
  }

  rest = rest.replace(/^[?!]/, "").trimStart();
  if (rest.startsWith("<")) {
    rest = rest.slice(balancedEnd(rest, 0) + 1).trimStart();
  }
  let params: string | undefined;
  if (compartment === "method" && rest.startsWith("(")) {
    const close = balancedEnd(rest, 0);
    params = compactParams(rest.slice(1, close));
    rest = rest.slice(close + 1).trim();
  } else if (compartment === "method") {
    params = "";
  }
  rest = rest.replace(/^[?!]/, "").trim();

  let type: string | undefined;
  if (rest.startsWith(":")) {
    type = rest.slice(1).trim();
  } else if (rest.startsWith("->")) {
    type = rest.slice(2).trim();
  } else if (
    rest !== "" &&
    !/^(=|throws\b|where\b|noexcept\b|const\b|extends\b|with\b|in\b)/.test(rest)
  ) {
    type = rest;
  }
  if (type !== undefined) {
    type = collapse(type.replace(TRAILING_CLAUSE, ""));
  }
  if (!type && prefixType.length > 0) {
    type = prefixType.join(" ");
  }
  if (!type) {
    const fromDetail = collapse(detail.replace(/^\s*[:\-=>]+\s*/, ""));
    if (fromDetail !== "" && fromDetail.length <= 60 && fromDetail !== plain) {
      type = fromDetail;
    }
  }
  if (type === "") {
    type = undefined;
  }

  const head = `${visibility ? `${visibility} ` : ""}${plain}`;
  const label =
    compartment === "method"
      ? `${head}(${params ?? ""})${type ? `: ${type}` : ""}`
      : `${head}${type ? `: ${type}` : ""}`;
  const short = compartment === "method" ? `${head}(${paramNames(params ?? "")})` : label;
  return { visibility, isStatic, isAbstract, params, type, label, short };
}

function paramNames(params: string): string {
  return splitTopLevel(params)
    .map((part) => {
      const at = part.indexOf(":");
      return collapse(at > 0 ? part.slice(0, at) : part).replace(/\s*=.*$/, "");
    })
    .filter((part) => part !== "")
    .join(", ");
}
