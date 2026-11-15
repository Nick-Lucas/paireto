import { countInRange, type LineDiff } from "./lineDiff.js";
import type {
  DiffSide,
  DiffedMember,
  DiffedType,
  LineCounts,
  MemberChange,
  TypeChange,
  TypeRefs,
} from "./model.js";
import { MODULE_KEY, type OutlineMember, type OutlineType } from "./outline.js";

function refsOf(type: OutlineType): TypeRefs {
  const ref = (member: OutlineMember) => ({
    key: member.key,
    text: [member.parsed.params ?? "", member.parsed.type ?? ""].join(" "),
    ...member.head,
  });
  return {
    head: type.head,
    supertypes: type.supertypes,
    realizes: type.realizes,
    fields: type.members.filter((m) => m.compartment === "field").map(ref),
    methods: type.members.filter((m) => m.compartment === "method").map(ref),
  };
}

function memberChange(
  base: OutlineMember | undefined,
  modified: OutlineMember | undefined,
): MemberChange {
  if (!base) {
    return "added";
  }
  if (!modified) {
    return "removed";
  }
  if (base.signature !== modified.signature) {
    return "signature";
  }
  if (base.body !== modified.body) {
    return "body";
  }
  return "unchanged";
}

function outsideTypes(lines: ReadonlySet<number>, types: readonly OutlineType[]): number {
  const ranges = types.filter((t) => t.key !== MODULE_KEY).map((t) => [t.start, t.end]);
  let count = 0;
  for (const line of lines) {
    if (!ranges.some(([start, end]) => line >= start && line <= end)) {
      count++;
    }
  }
  return count;
}

interface MemberPair {
  base?: OutlineMember;
  modified?: OutlineMember;
}

function orderMembers(
  base: readonly OutlineMember[],
  modified: readonly OutlineMember[],
): MemberPair[] {
  const baseByKey = new Map(base.map((m) => [m.key, m]));
  const modifiedKeys = new Set(modified.map((m) => m.key));
  const result: MemberPair[] = modified.map((m) => ({ base: baseByKey.get(m.key), modified: m }));
  base.forEach((member, index) => {
    if (modifiedKeys.has(member.key)) {
      return;
    }
    let insertAt = 0;
    for (let i = index - 1; i >= 0; i--) {
      const at = result.findIndex((entry) => (entry.base ?? entry.modified)?.key === base[i].key);
      if (at >= 0) {
        insertAt = at + 1;
        break;
      }
    }
    result.splice(insertAt, 0, { base: member });
  });
  return result;
}

function diffMember(pair: MemberPair, diff: LineDiff): DiffedMember {
  const change = memberChange(pair.base, pair.modified);
  const shown = (pair.modified ?? pair.base) as OutlineMember;
  const side: DiffSide = pair.modified ? "modified" : "base";
  return {
    key: shown.key,
    name: shown.name,
    kind: shown.kind,
    visibility: shown.parsed.visibility,
    isStatic: shown.parsed.isStatic,
    isAbstract: shown.parsed.isAbstract,
    label: shown.parsed.label,
    short: shown.parsed.short,
    previousLabel:
      change === "signature" && pair.base && pair.base.parsed.label !== shown.parsed.label
        ? pair.base.parsed.label
        : undefined,
    change,
    counts: {
      added: pair.modified ? countInRange(diff.added, pair.modified.start, pair.modified.end) : 0,
      removed: pair.base ? countInRange(diff.removed, pair.base.start, pair.base.end) : 0,
    },
    span: { side, start: shown.start, end: shown.end },
  };
}

export function diffFile(
  baseTypes: readonly OutlineType[],
  modifiedTypes: readonly OutlineType[],
  diff: LineDiff,
): DiffedType[] {
  const baseByKey = new Map(baseTypes.map((t) => [t.key, t]));
  const modifiedByKey = new Map(modifiedTypes.map((t) => [t.key, t]));
  const keys = [
    ...modifiedTypes.map((t) => t.key),
    ...baseTypes.filter((t) => !modifiedByKey.has(t.key)).map((t) => t.key),
  ];
  return keys.map((key): DiffedType => {
    const base = baseByKey.get(key);
    const modified = modifiedByKey.get(key);
    const members = orderMembers(base?.members ?? [], modified?.members ?? []).map((pair) =>
      diffMember(pair, diff),
    );
    const counts: LineCounts =
      key === MODULE_KEY
        ? {
            added: modified ? outsideTypes(diff.added, modifiedTypes) : 0,
            removed: base ? outsideTypes(diff.removed, baseTypes) : 0,
          }
        : {
            added: modified ? countInRange(diff.added, modified.start, modified.end) : 0,
            removed: base ? countInRange(diff.removed, base.start, base.end) : 0,
          };
    const headerChanged = !!base && !!modified && base.header !== modified.header;
    let change: TypeChange;
    if (!base) {
      change = "added";
    } else if (!modified) {
      change = "removed";
    } else if (
      headerChanged ||
      members.some((m) => m.change !== "unchanged") ||
      counts.added + counts.removed > 0
    ) {
      change = "modified";
    } else {
      change = "unchanged";
    }
    const shown = (modified ?? base) as OutlineType;
    return {
      key,
      name: shown.name,
      kind: shown.kind,
      isAbstract: shown.isAbstract,
      change,
      headerChanged,
      counts,
      members,
      span: { side: modified ? "modified" : "base", start: shown.start, end: shown.end },
      refs: {
        base: base ? refsOf(base) : undefined,
        modified: modified ? refsOf(modified) : undefined,
      },
    };
  });
}
