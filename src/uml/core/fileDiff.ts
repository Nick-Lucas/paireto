import { countInRange, type LineDiff } from "./lineDiff.js";
import type {
  DiffSide,
  LineCounts,
  MemberChange,
  TypeChange,
  UmlMember,
  UmlType,
} from "./model.js";
import { MODULE_KEY, type OutlineMember, type OutlineType } from "./outline.js";

export interface FileSideInput {
  lineCount: number;
  types: OutlineType[];
}

export interface ThreadPosition {
  side: DiffSide;
  line: number;
}

export interface FileDiffInput {
  fileKey: string;
  fileName: string;
  base?: FileSideInput;
  modified?: FileSideInput;
  diff: LineDiff;
  threads: ThreadPosition[];
}

export interface MemberRef {
  id: string;
  name: string;
  text: string;
}

export interface TypeRefs {
  supertypes: string[];
  realizes: string[];
  fields: MemberRef[];
  methods: MemberRef[];
}

export interface DiffedType {
  type: UmlType;
  refs: { base?: TypeRefs; modified?: TypeRefs };
}

function refsOf(type: OutlineType, typeId: string): TypeRefs {
  const ref = (member: OutlineMember): MemberRef => ({
    id: `${typeId}::${member.key}`,
    name: member.name,
    text: [member.parsed.params ?? "", member.parsed.type ?? ""].join(" "),
  });
  return {
    supertypes: type.supertypes,
    realizes: type.realizes,
    fields: type.members.filter((m) => m.compartment === "field").map(ref),
    methods: type.members.filter((m) => m.compartment === "method").map(ref),
  };
}

function threadsIn(threads: ThreadPosition[], side: DiffSide, start: number, end: number): number {
  return threads.filter((t) => t.side === side && t.line >= start && t.line <= end).length;
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

function orderMembers(
  base: readonly OutlineMember[],
  modified: readonly OutlineMember[],
): { base?: OutlineMember; modified?: OutlineMember }[] {
  const baseByKey = new Map(base.map((m) => [m.key, m]));
  const modifiedKeys = new Set(modified.map((m) => m.key));
  const result: { base?: OutlineMember; modified?: OutlineMember }[] = modified.map((m) => ({
    base: baseByKey.get(m.key),
    modified: m,
  }));
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

export function diffFile(input: FileDiffInput): DiffedType[] {
  const baseTypes = input.base?.types ?? [];
  const modifiedTypes = input.modified?.types ?? [];
  const baseByKey = new Map(baseTypes.map((t) => [t.key, t]));
  const modifiedByKey = new Map(modifiedTypes.map((t) => [t.key, t]));
  const keys = [
    ...modifiedTypes.map((t) => t.key),
    ...baseTypes.filter((t) => !modifiedByKey.has(t.key)).map((t) => t.key),
  ];
  const { added, removed } = input.diff;
  const result: DiffedType[] = [];

  for (const key of keys) {
    const base = baseByKey.get(key);
    const modified = modifiedByKey.get(key);
    const isModule = key === MODULE_KEY;
    const typeId = `${input.fileKey}::${key}`;
    const members: UmlMember[] = orderMembers(base?.members ?? [], modified?.members ?? []).map(
      (pair) => {
        const change = memberChange(pair.base, pair.modified);
        const shown = (pair.modified ?? pair.base) as OutlineMember;
        const side: DiffSide = pair.modified ? "modified" : "base";
        const counts: LineCounts = {
          added: pair.modified ? countInRange(added, pair.modified.start, pair.modified.end) : 0,
          removed: pair.base ? countInRange(removed, pair.base.start, pair.base.end) : 0,
        };
        return {
          id: `${typeId}::${shown.key}`,
          name: shown.name,
          compartment: shown.compartment,
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
          counts,
          span: { side, start: shown.start, end: shown.end },
          openThreads: threadsIn(input.threads, side, shown.start, shown.end),
        };
      },
    );

    const counts: LineCounts = isModule
      ? {
          added: modified ? outsideTypes(added, modifiedTypes) : 0,
          removed: base ? outsideTypes(removed, baseTypes) : 0,
        }
      : {
          added: modified ? countInRange(added, modified.start, modified.end) : 0,
          removed: base ? countInRange(removed, base.start, base.end) : 0,
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
    const side: DiffSide = modified ? "modified" : "base";
    const typeThreads = isModule
      ? members.reduce((sum, m) => sum + m.openThreads, 0)
      : threadsIn(input.threads, side, shown.start, shown.end);
    result.push({
      type: {
        id: typeId,
        name: isModule ? input.fileName : shown.name,
        kind: shown.kind,
        isAbstract: shown.isAbstract,
        fileKey: input.fileKey,
        change,
        headerChanged,
        counts,
        members,
        span: { side, start: shown.start, end: shown.end },
        context: false,
        openThreads: typeThreads,
      },
      refs: {
        base: base ? refsOf(base, typeId) : undefined,
        modified: modified ? refsOf(modified, typeId) : undefined,
      },
    });
  }
  return result;
}

export function fileType(
  fileKey: string,
  fileName: string,
  change: TypeChange,
  counts: LineCounts,
  openThreads: number,
): DiffedType {
  return {
    type: {
      id: `${fileKey}::<file>`,
      name: fileName,
      kind: "file",
      isAbstract: false,
      fileKey,
      change,
      headerChanged: false,
      counts,
      members: [],
      context: false,
      openThreads,
    },
    refs: {},
  };
}
