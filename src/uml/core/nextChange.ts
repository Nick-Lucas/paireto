import type { FocusedView, VisibleType } from "./focus.js";
import type { UmlFile } from "./model.js";

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

interface Spot {
  typeId: string;
  memberId?: string;
}

function spotsOf(types: readonly VisibleType[]): Spot[] {
  return types.flatMap(({ type, members }) =>
    members.length > 0
      ? members.map((m) => ({ typeId: type.id, memberId: m.id }))
      : [{ typeId: type.id }],
  );
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
  const spotsIn = (fileKey: string) => spotsOf(ranked.filter((t) => t.type.fileKey === fileKey));
  const stopAt = (fileKey: string, index: number): ChangeStop => {
    const spots = spotsIn(fileKey);
    return { fileKey, index, count: spots.length, ...spots[index] };
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
    const spots = spotsIn(picked);
    const member = spots.findIndex((s) => s.typeId === from.typeId && s.memberId === from.memberId);
    const index = !from.typeId
      ? 0
      : member >= 0
        ? member
        : spots.findIndex((s) => s.typeId === from.typeId);
    return index >= 0 && index < spots.length ? index : undefined;
  };
  const cursor = from.cursor;
  if (cursor && (!picked || picked === cursor.fileKey)) {
    const start = pickedStart();
    if (start !== undefined && start > cursor.index) {
      return { stop: stopAt(cursor.fileKey, start) };
    }
    const count = spotsIn(cursor.fileKey).length;
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
