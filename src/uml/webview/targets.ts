import type { MemberChange, UmlFile, UmlMember, UmlType } from "../core/model";

export type Target =
  | { kind: "type"; typeId: string }
  | { kind: "member"; typeId: string; memberId: string }
  | { kind: "file"; fileKey: string };

export function targetKey(target: Target): string {
  switch (target.kind) {
    case "type":
      return `t:${target.typeId}`;
    case "member":
      return `m:${target.memberId}`;
    case "file":
      return `f:${target.fileKey}`;
  }
}

export function sameTarget(a: Target | undefined, b: Target | undefined): boolean {
  return !!a && !!b && targetKey(a) === targetKey(b);
}

const GLYPHS: Record<MemberChange, string> = {
  added: "A",
  removed: "D",
  signature: "S",
  body: "M",
  unchanged: "",
};

export function memberGlyph(change: MemberChange): string {
  return GLYPHS[change];
}

export const RELATION_WORDS: Record<string, string> = {
  generalization: "extends",
  realization: "implements",
  association: "has",
  dependency: "uses",
};

export const MEMBER_CHANGE_WORDS: Record<MemberChange, string> = {
  added: "Added",
  removed: "Removed",
  signature: "Signature changed",
  body: "Body changed",
  unchanged: "Unchanged",
};

export const TYPE_CHANGE_WORDS: Record<UmlType["change"], string> = {
  added: "Added",
  removed: "Removed",
  modified: "Changed",
  unchanged: "Unchanged",
};

export const KIND_WORDS: Record<UmlType["kind"], string> = {
  class: "Class",
  interface: "Interface",
  enum: "Enumeration",
  struct: "Struct",
  module: "Module",
  file: "File",
};

export function lines(count: number): string {
  return `${count} ${count === 1 ? "line" : "lines"}`;
}

export function describeType(type: UmlType, file: UmlFile | undefined): string {
  const parts = [`${KIND_WORDS[type.kind]} ${type.name}`];
  parts.push(type.context ? "context, outside the change" : TYPE_CHANGE_WORDS[type.change]);
  if (type.counts.added + type.counts.removed > 0) {
    parts.push(
      `whole type ${lines(type.counts.added)} added, ${lines(type.counts.removed)} removed`,
    );
  }
  if (file && file.status !== "context") {
    parts.push(file.read ? "file read" : "file not read");
  }
  if (type.openThreads > 0) {
    parts.push(`${type.openThreads} open threads`);
  }
  return parts.join(", ");
}

export function describeMember(member: UmlMember, type: UmlType): string {
  const parts = [`${member.label}`, `in ${type.name}`, MEMBER_CHANGE_WORDS[member.change]];
  if (member.counts.added + member.counts.removed > 0) {
    parts.push(
      `this member ${lines(member.counts.added)} added, ${lines(member.counts.removed)} removed`,
    );
  }
  if (member.openThreads > 0) {
    parts.push(`${member.openThreads} open threads`);
  }
  return parts.join(", ");
}
