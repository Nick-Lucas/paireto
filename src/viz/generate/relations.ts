import type {
  ContextType,
  DefinitionHit,
  DefinitionQuery,
  DiffSide,
  DiffedType,
  GeneratedFileModel,
  MemberRef,
  RepoLine,
  TypeKind,
  TypeRefs,
  TypeSite,
} from "./model.js";

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

const NOT_CONTEXT = new Set([
  "Array",
  "ArrayList",
  "Boolean",
  "Callable",
  "Collection",
  "Date",
  "Dict",
  "Error",
  "Exception",
  "False",
  "Function",
  "HashMap",
  "Iterable",
  "Iterator",
  "List",
  "Map",
  "None",
  "Number",
  "Object",
  "Option",
  "Optional",
  "Partial",
  "Promise",
  "ReadonlyArray",
  "Record",
  "Result",
  "Self",
  "Set",
  "String",
  "True",
  "Tuple",
  "Union",
  "Vec",
]);

const MANY =
  /\[\s*\]|\b(Array|ReadonlyArray|List|ArrayList|Set|HashSet|Map|HashMap|Vec|Collection|Iterable|Sequence|Record|Dict|dict|list|set|tuple|Seq)\s*[<[(]/;
const OPTIONAL = /\?|\|\s*(undefined|null)\b|\b(Optional|Option)\s*[<[]|\bNone\b|^\s*\*/;

export type RelationKind = "extends" | "implements" | "association" | "dependency";

export type RelationChange = "added" | "removed" | "unchanged";

export interface Relation {
  kind: RelationKind;
  source: string;
  target: string;
  multiplicity?: string;
  via: string[];
  change: RelationChange;
}

interface IndexedType extends TypeSite {
  key: string;
  name: string;
  kind: TypeKind;
  start: number;
  end: number;
}

interface RelationSource {
  type: IndexedType;
  diffed: DiffedType;
}

export interface TypeGraph {
  sources: RelationSource[];
  index: TypeIndex;
}

export function multiplicityOf(text: string): string | undefined {
  if (MANY.test(text)) {
    return "0..*";
  }
  if (OPTIONAL.test(text)) {
    return "0..1";
  }
  return undefined;
}

export function siteKey(site: TypeSite): string {
  return `${site.repo}\n${site.path}\n${site.type}`;
}

export function contextSite(context: ContextType): TypeSite {
  return { repo: context.repo, path: context.path, type: `context:${context.name}` };
}

function dirOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

class TypeIndex {
  private readonly byName = new Map<string, IndexedType[]>();

  constructor(types: readonly IndexedType[]) {
    for (const type of types) {
      if (type.kind === "module") {
        continue;
      }
      const short = type.name.split(".").pop() ?? type.name;
      for (const name of new Set([type.name, short])) {
        this.byName.set(name, [...(this.byName.get(name) ?? []), type]);
      }
    }
  }

  candidates(name: string): readonly IndexedType[] {
    return this.byName.get(name) ?? [];
  }

  resolve(name: string, from: TypeSite, hit: RepoLine | undefined): IndexedType | undefined {
    const candidates = this.candidates(name);
    const defined =
      hit &&
      candidates.find(
        (c) =>
          c.repo === hit.repo && c.path === hit.path && hit.line >= c.start && hit.line <= c.end,
      );
    return (
      defined ||
      candidates.find((c) => c.repo === from.repo && c.path === from.path) ||
      candidates.find((c) => c.repo === from.repo && dirOf(c.path) === dirOf(from.path)) ||
      candidates[0]
    );
  }
}

export function typeGraph(
  files: readonly GeneratedFileModel[],
  context: readonly ContextType[],
): TypeGraph {
  const sources = files.flatMap((file) =>
    (file.types ?? []).map((diffed): RelationSource => ({
      diffed,
      type: {
        repo: file.repo,
        path: file.path,
        type: diffed.key,
        key: siteKey({ repo: file.repo, path: file.path, type: diffed.key }),
        name: diffed.name,
        kind: diffed.kind,
        start: diffed.span.side === "modified" ? diffed.span.start : -1,
        end: diffed.span.side === "modified" ? diffed.span.end : -1,
      },
    })),
  );
  const contextTypes = context.map((c): IndexedType => {
    const site = contextSite(c);
    return { ...site, key: siteKey(site), name: c.name, kind: c.kind, start: c.line, end: c.line };
  });
  return { sources, index: new TypeIndex([...sources.map((s) => s.type), ...contextTypes]) };
}

function identifiers(text: string): string[] {
  return text.match(IDENTIFIER) ?? [];
}

function hitKey(site: TypeSite, name: string): string {
  return `${siteKey(site)}\n${name}`;
}

function sideRelations(
  type: IndexedType,
  refs: TypeRefs,
  index: TypeIndex,
  hits: ReadonlyMap<string, RepoLine>,
): Omit<Relation, "change">[] {
  const found = new Map<string, Omit<Relation, "change">>();
  const resolve = (name: string) => index.resolve(name, type, hits.get(hitKey(type, name)));
  const add = (kind: RelationKind, name: string, multiplicity?: string, via?: MemberRef): void => {
    const target = resolve(name);
    if (!target || target.key === type.key) {
      return;
    }
    const key = `${kind}:${target.key}`;
    let relation = found.get(key);
    if (!relation) {
      relation = { kind, source: type.key, target: target.key, multiplicity, via: [] };
      found.set(key, relation);
    }
    if (via && !relation.via.includes(via.key)) {
      relation.via.push(via.key);
    }
  };
  for (const name of refs.supertypes) {
    const target = resolve(name);
    if (target) {
      add(
        type.kind !== "interface" && target.kind === "interface" ? "implements" : "extends",
        name,
      );
    }
  }
  for (const name of refs.realizes) {
    add("implements", name);
  }
  for (const member of refs.fields) {
    for (const name of identifiers(member.text)) {
      add("association", name, multiplicityOf(member.text), member);
    }
  }
  for (const member of refs.methods) {
    for (const name of identifiers(member.text)) {
      add("dependency", name, undefined, member);
    }
  }
  const relations = [...found.values()];
  const structural = new Set(relations.filter((r) => r.kind !== "dependency").map((r) => r.target));
  const generalized = new Set(
    relations.filter((r) => r.kind === "extends" || r.kind === "implements").map((r) => r.target),
  );
  return relations.filter(
    (r) =>
      !(r.kind === "dependency" && structural.has(r.target)) &&
      !(r.kind === "association" && generalized.has(r.target)),
  );
}

export function buildRelations(
  graph: TypeGraph,
  definitions: readonly DefinitionHit[],
): Relation[] {
  const hits = new Map(definitions.map((hit) => [hitKey(hit.from, hit.name), hit.target]));
  const relations = new Map<string, Relation>();
  for (const side of ["base", "modified"] as DiffSide[]) {
    for (const { type, diffed } of graph.sources) {
      const refs = diffed.refs[side];
      if (!refs) {
        continue;
      }
      for (const relation of sideRelations(type, refs, graph.index, hits)) {
        const id = `${relation.kind}:${relation.source}->${relation.target}`;
        const existing = relations.get(id);
        if (!existing) {
          relations.set(id, { ...relation, change: side === "base" ? "removed" : "added" });
        } else if (side === "modified") {
          existing.change = existing.change === "removed" ? "unchanged" : existing.change;
          existing.multiplicity = relation.multiplicity;
          existing.via = relation.via;
        }
      }
    }
  }
  return [...relations.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, r]) => r);
}

function referencedNames(refs: TypeRefs): { name: string; line: number; endLine: number }[] {
  return [
    ...[...refs.supertypes, ...refs.realizes].map((name) => ({ name, ...refs.head })),
    ...[...refs.fields, ...refs.methods].flatMap((member) =>
      identifiers(member.text).map((name) => ({
        name,
        line: member.line,
        endLine: member.endLine,
      })),
    ),
  ];
}

export function unresolvedNames(graph: TypeGraph, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const { diffed } of graph.sources) {
    if (diffed.change === "unchanged") {
      continue;
    }
    for (const refs of [diffed.refs.modified, diffed.refs.base]) {
      if (!refs) {
        continue;
      }
      const names = [
        ...refs.supertypes,
        ...refs.realizes,
        ...refs.fields.flatMap((member) => identifiers(member.text)),
      ];
      for (const name of names) {
        if (
          /^[A-Z][\w$]+$/.test(name) &&
          !NOT_CONTEXT.has(name) &&
          graph.index.candidates(name).length === 0
        ) {
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name]) => name);
}

export function definitionQueries(graph: TypeGraph, limit: number): DefinitionQuery[] {
  const queries = new Map<string, DefinitionQuery>();
  for (const { type, diffed } of graph.sources) {
    const refs = diffed.refs.modified;
    if (!refs || diffed.change === "unchanged") {
      continue;
    }
    const from: TypeSite = { repo: type.repo, path: type.path, type: type.type };
    for (const { name, line, endLine } of referencedNames(refs)) {
      const key = hitKey(from, name);
      if (graph.index.candidates(name).length > 1 && !queries.has(key)) {
        queries.set(key, { from, name, line, endLine });
      }
    }
  }
  return [...queries.values()].slice(0, limit);
}
