import type { DiffedType, MemberRef, TypeRefs } from "./fileDiff.js";
import type { DiffSide, RelationKind, UmlRelation, UmlType } from "./model.js";

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

export function multiplicityOf(text: string): string | undefined {
  if (MANY.test(text)) {
    return "0..*";
  }
  if (OPTIONAL.test(text)) {
    return "0..1";
  }
  return undefined;
}

function dirOf(fileKey: string): string {
  const at = fileKey.lastIndexOf("/");
  return at < 0 ? "" : fileKey.slice(0, at);
}

export class TypeIndex {
  private readonly byName = new Map<string, UmlType[]>();

  constructor(types: readonly UmlType[]) {
    for (const type of types) {
      if (type.kind === "module" || type.kind === "file") {
        continue;
      }
      const short = type.name.split(".").pop() ?? type.name;
      for (const name of new Set([type.name, short])) {
        this.byName.set(name, [...(this.byName.get(name) ?? []), type]);
      }
    }
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  resolve(name: string, from: UmlType): UmlType | undefined {
    const candidates = this.byName.get(name);
    if (!candidates) {
      return undefined;
    }
    return (
      candidates.find((c) => c.fileKey === from.fileKey) ??
      candidates.find((c) => dirOf(c.fileKey) === dirOf(from.fileKey)) ??
      candidates[0]
    );
  }
}

interface SideRelation {
  kind: RelationKind;
  source: string;
  target: string;
  multiplicity?: string;
  via: string[];
  roles: string[];
}

function identifiers(text: string): string[] {
  return text.match(IDENTIFIER) ?? [];
}

function sideRelations(type: UmlType, refs: TypeRefs, index: TypeIndex): SideRelation[] {
  const found = new Map<string, SideRelation>();
  const add = (kind: RelationKind, name: string, multiplicity?: string, via?: MemberRef): void => {
    const target = index.resolve(name, type);
    if (!target || target.id === type.id) {
      return;
    }
    const key = `${kind}:${target.id}`;
    let relation = found.get(key);
    if (!relation) {
      relation = { kind, source: type.id, target: target.id, multiplicity, via: [], roles: [] };
      found.set(key, relation);
    }
    if (via && !relation.via.includes(via.id)) {
      relation.via.push(via.id);
      relation.roles.push(via.name);
    }
  };
  for (const name of refs.supertypes) {
    const target = index.resolve(name, type);
    if (target) {
      add(
        type.kind !== "interface" && target.kind === "interface" ? "realization" : "generalization",
        name,
      );
    }
  }
  for (const name of refs.realizes) {
    add("realization", name);
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
  const structural = new Set(
    [...found.values()].filter((r) => r.kind !== "dependency").map((r) => r.target),
  );
  const generalized = new Set(
    [...found.values()]
      .filter((r) => r.kind === "generalization" || r.kind === "realization")
      .map((r) => r.target),
  );
  return [...found.values()].filter(
    (r) =>
      !(r.kind === "dependency" && structural.has(r.target)) &&
      !(r.kind === "association" && generalized.has(r.target)),
  );
}

export function buildRelations(
  entries: readonly DiffedType[],
  contextTypes: readonly UmlType[] = [],
): UmlRelation[] {
  const index = new TypeIndex([...entries.map((e) => e.type), ...contextTypes]);
  const relations = new Map<string, UmlRelation>();
  for (const side of ["base", "modified"] as DiffSide[]) {
    for (const entry of entries) {
      const refs = entry.refs[side];
      if (!refs) {
        continue;
      }
      for (const relation of sideRelations(entry.type, refs, index)) {
        const id = `${relation.kind}:${relation.source}->${relation.target}`;
        const existing = relations.get(id);
        if (!existing) {
          relations.set(id, { id, ...relation, change: side === "base" ? "removed" : "added" });
        } else if (side === "modified") {
          existing.change = existing.change === "removed" ? "unchanged" : existing.change;
          existing.multiplicity = relation.multiplicity;
          existing.via = relation.via;
          existing.roles = relation.roles;
        }
      }
    }
  }
  return [...relations.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function unresolvedNames(entries: readonly DiffedType[], limit: number): string[] {
  const index = new TypeIndex(entries.map((e) => e.type));
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type.change === "unchanged") {
      continue;
    }
    for (const refs of [entry.refs.modified, entry.refs.base]) {
      if (!refs) {
        continue;
      }
      const names = [
        ...refs.supertypes,
        ...refs.realizes,
        ...refs.fields.flatMap((member) => identifiers(member.text)),
      ];
      for (const name of names) {
        if (/^[A-Z][\w$]+$/.test(name) && !NOT_CONTEXT.has(name) && !index.has(name)) {
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
