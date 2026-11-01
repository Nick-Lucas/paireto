import type { FocusedView, VisibleType } from "./focus.js";
import type { SourceSpan, UmlFile } from "./model.js";

export interface ChangeCursor {
  fileKey: string;
  index: number;
}

export interface ChangeStop extends ChangeCursor {
  count: number;
  typeId?: string;
  memberId?: string;
}

export interface ChangeStep {
  stop?: ChangeStop;
  seen?: string;
}

export interface ChangeFrom {
  cursor?: ChangeCursor;
  typeId?: string;
  memberId?: string;
  fileKey?: string;
}

function overlaps(a: SourceSpan, b: SourceSpan): boolean {
  return a.side === b.side && a.start <= b.end && b.start <= a.end;
}

function holderOf(
  types: readonly VisibleType[],
  change: SourceSpan | undefined,
): { typeId?: string; memberId?: string } {
  if (change) {
    for (const { type, members } of types) {
      const member = members.find((m) => overlaps(m.span, change));
      if (member) {
        return { typeId: type.id, memberId: member.id };
      }
    }
    const holder = types.find(({ type }) => type.span && overlaps(type.span, change));
    if (holder) {
      return { typeId: holder.type.id };
    }
  }
  return { typeId: types[0]?.type.id };
}

export function nextChange(
  view: FocusedView,
  files: readonly UmlFile[],
  from: ChangeFrom,
): ChangeStep {
  const byKey = new Map(files.map((f) => [f.key, f]));
  const ranked = view.types
    .filter((t) => t.role === "primary")
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  const stopAt = (fileKey: string, index: number): ChangeStop => {
    const changes = byKey.get(fileKey)?.changes ?? [];
    return {
      fileKey,
      index,
      count: changes.length,
      ...holderOf(
        ranked.filter((t) => t.type.fileKey === fileKey),
        changes[index],
      ),
    };
  };
  const moveOn = (seen: string | undefined): ChangeStep => {
    const next = ranked.find((t) => t.type.fileKey !== seen && !byKey.get(t.type.fileKey)?.read);
    const marked = seen && byKey.get(seen)?.status !== "context" ? seen : undefined;
    return { seen: marked, stop: next ? stopAt(next.type.fileKey, 0) : undefined };
  };
  const picked = from.typeId
    ? view.types.find((t) => t.type.id === from.typeId)?.type.fileKey
    : from.fileKey;
  const pickedStart = (): number | undefined => {
    if (!picked) {
      return undefined;
    }
    const visible = view.types.find((t) => t.type.id === from.typeId);
    const span = visible?.members.find((m) => m.id === from.memberId)?.span ?? visible?.type.span;
    const changes = byKey.get(picked)?.changes ?? [];
    const index = span ? changes.findIndex((c) => c.side === span.side && c.end >= span.start) : 0;
    return index >= 0 && index < changes.length ? index : undefined;
  };
  const cursor = from.cursor;
  if (cursor && (!picked || picked === cursor.fileKey)) {
    const start = pickedStart();
    if (start !== undefined && start > cursor.index) {
      return { stop: stopAt(cursor.fileKey, start) };
    }
    const count = byKey.get(cursor.fileKey)?.changes.length ?? 0;
    return cursor.index + 1 < count
      ? { stop: stopAt(cursor.fileKey, cursor.index + 1) }
      : moveOn(cursor.fileKey);
  }
  if (picked) {
    const start = pickedStart();
    return start !== undefined ? { stop: stopAt(picked, start) } : moveOn(picked);
  }
  return moveOn(undefined);
}
